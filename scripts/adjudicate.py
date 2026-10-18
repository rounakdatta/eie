#!/usr/bin/env python3
"""Settle speaker disagreements between the voiceprint labels and FluidAudio's diarization.

  python3 scripts/adjudicate.py [N ...]   # every transcribed episode not yet settled
  python3 scripts/adjudicate.py --again N # look again at an episode already settled

Voiceprints can mistake a host for the other when his sound changes, as when he presents his
screen (Ajay's Unix demo in Episode 32), and they often hand the end of one of Ajay's sentences
to Amit. FluidAudio, which clusters within the episode, usually gets those stretches right but
misses short interjections that the voiceprints catch. So the voiceprint labels stand, except
where the two disagree for at least MIN_STRETCH seconds. There Claude reads the passage in
context and decides who is speaking: who is addressed by name, what the speaker says about
himself, how the conversation flows.

An episode settled earlier at 5 seconds and more (LONG_NOTE) is only asked about the stretches
it hasn't been asked about. An episode whose insights were extracted from the labels before
settling keeps them: Claude reads the corrected passages beside the insights and fixes any that
now credit the wrong host (a story's teller, a recommendation's recommender, a host named in a
joke or a core idea). The rest of each insight stays as extracted.

Needs `pip install anthropic numpy`; Claude is reached through the auth2api gateway, with its
key in work/.auth2api-key.
"""
import collections
import concurrent.futures
import difflib
import json
import os
import re
import sys

import anthropic
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPTS = os.path.join(ROOT, "data", "original", "transcripts")
METADATA = os.path.join(ROOT, "data", "original", "metadata")
WORK = os.path.join(ROOT, "work")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
HOSTS = ("Amit Varma", "Ajay Shah")
MIN_STRETCH = 2.0
NOTE = "; disagreements with FluidAudio of 2 s or more settled by Claude"
LONG_NOTE = "; long disagreements with FluidAudio settled by Claude"  # 5 s or more, in episodes under 95% agreement
INSIGHTS = os.path.join(ROOT, "data", "generated", "insights")
AUDIT = """You check curated insights from an episode of Everything is Everything, a podcast hosted by Amit
Varma and Ajay Shah. Some speaker labels in the episode's transcript have just been corrected. The insights were
written from the transcript before the correction, so where a corrected passage is the source of an insight, the
insight may credit the wrong host: a story's teller, a recommendation's recommender, or a host named in a joke or
in a core idea's explanation.

For each insight that a corrected passage shows to credit the wrong host, return a correction:
- for a story (S), the field "teller" and the right host's full name;
- for a recommendation (R), the field "recommender" and the right host's full name;
- for a joke or reference (J), the field "content" and the whole text, changed only as far as it takes to credit
  each line to the right host;
- for a core idea (C), the field "explanation" and the whole text, changed the same way.
Keep every quote and every other word as it is. Return no correction for an insight the passages don't bear on, or
that is still right. Most insights need none."""
AUDIT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["corrections"], "properties": {
    "corrections": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["id", "field", "value", "reason"],
        "properties": {"id": {"type": "string"}, "field": {"type": "string", "enum": ["teller", "recommender", "content", "explanation"]},
                       "value": {"type": "string"}, "reason": {"type": "string"}}}}}}
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["speaker", "reason"],
          "properties": {"speaker": {"type": "string", "enum": [*HOSTS, "unsure"]}, "reason": {"type": "string"}}}
SYSTEM = """You identify speakers in a transcript of Everything is Everything, a podcast hosted by
Amit Varma and Ajay Shah.

Amit Varma is a writer and podcaster: he hosts The Seen and the Unseen, writes India Uncut,
teaches The Art of Clear Writing, was a professional poker player, worked as a cricket
journalist (Cricinfo), loves chess, and calls himself half Bengali. Ajay Shah is an economist:
he co-founded XKDR Forum, wrote In Service of the Republic with Vijay Kelkar, works in Unix and
Emacs, writes code, and loves cycling and hiking.

Two automatic systems disagree about who speaks a passage. Decide from what is said: who is
addressed by name (a speaker doesn't address himself), what the speaker says about his own life
and work, how he refers to the other host, and how the conversation flows from the turns around
it. Answer "unsure" if the passage doesn't settle it."""


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def turns_text(words, labels, lo, hi):
    out, cur = [], None
    for w, s in zip(words[lo:hi], labels[lo:hi]):
        if s != cur:
            out.append(f"\n{s}: ")
            cur = s
        out.append(w["word"] + " ")
    return "".join(out).strip()


def fluid_labels(old, words, labels):
    """FluidAudio's speaker at each new word, mapped to a host name by majority overlap."""
    spans = sorted((seg["startTime"], seg["endTime"], seg["speaker"]) for seg in old["segments"])
    starts = [s for s, _, _ in spans]
    raw = []
    for w in words:
        m = (w["startTime"] + w["endTime"]) / 2
        i = int(np.searchsorted(starts, m, side="right")) - 1
        raw.append(spans[i][2] if i >= 0 and spans[i][0] <= m <= spans[i][1] else None)
    counts = collections.Counter((r, s) for r, s in zip(raw, labels) if r is not None and s in HOSTS)
    total = collections.Counter(r for r in raw if r is not None)
    names = {}
    for r in total:
        if total[r] >= 0.05 * len(words):
            names[r] = max(HOSTS, key=lambda h: counts[(r, h)])
    if len(set(names.values())) < 2:  # FluidAudio heard one voice (Episode 76): nothing to compare against
        return [None] * len(words)
    return [names.get(r) for r in raw]


def disputes(words, labels, fluid):
    """Runs of words where both systems name a host and disagree, at least MIN_STRETCH seconds long."""
    runs, start = [], None
    for i, (s, f) in enumerate(zip(labels + [None], fluid + [None])):
        bad = s in HOSTS and f in HOSTS and s != f
        if bad and start is None:
            start = i
        elif not bad and start is not None:
            if words[i - 1]["endTime"] - words[start]["startTime"] >= MIN_STRETCH:
                runs.append((start, i))
            start = None
    return runs


def ask(client, title, words, labels, fluid, lo, hi):
    context = 160
    prompt = (f"Episode: {title}\n\nThe passage in question is between <passage> tags. The voiceprint system says "
              f"{labels[lo]}; the other system says {fluid[lo]}. The labels on the surrounding turns are the "
              f"voiceprint system's.\n\n{turns_text(words, labels, max(0, lo - context), lo)}\n\n<passage>\n"
              + " ".join(w["word"] for w in words[lo:hi]) + "\n</passage>\n\n"
              + turns_text(words, labels, hi, min(len(words), hi + context)) + "\n\nWho speaks the passage?")
    with client.messages.stream(model=MODEL, max_tokens=16000, system=SYSTEM,
                                messages=[{"role": "user", "content": prompt}],
                                output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}}
                                ) as stream:
        message = stream.get_final_message()
    return json.loads(next(b.text for b in message.content if b.type == "text"))


def asked_before(n):
    """The (start, end) of every stretch already put to Claude for this episode."""
    spans = []
    with open(os.path.join(WORK, "adjudicate-qc.jsonl"), encoding="utf-8") as f:
        for line in f:
            qc = json.loads(line)
            if qc["episode"] == n:
                spans += [(d["start"], d["start"] + d["seconds"]) for d in qc["decisions"]]
    return spans


def audit(client, title, insights, words, labels, changed):
    """Fix insights that credit the wrong host for a passage whose labels just changed. Returns what was done."""
    passages = []
    for lo, hi, was in changed:
        passages.append(f"<passage>\n{turns_text(words, labels, max(0, lo - 100), min(len(words), hi + 100))}\n</passage>\n"
                        f"Corrected: \"{' '.join(w['word'] for w in words[lo:hi])}\" was labelled {was}, is {labels[lo]}.")
    listed = []
    for kind, letter, fields in (("stories", "S", ("teller", "topic", "summary", "quote")),
                                 ("recommendations", "R", ("recommender", "item", "creator", "context")),
                                 ("jokes_and_cultural_references", "J", ("content",)),
                                 ("core_ideas", "C", ("concept", "explanation"))):
        for i, x in enumerate(insights.get(kind, []), 1):
            if kind != "core_ideas" or any(h.split()[0] in x["explanation"] for h in HOSTS):
                listed.append(json.dumps({"id": f"{letter}{i:02d}"} | {f: x[f] for f in fields if x.get(f)}, ensure_ascii=False))
    prompt = (f"Episode: {title}\n\nThe corrected passages, with the labels as they are now:\n\n" + "\n\n".join(passages)
              + "\n\nThe insights:\n" + "\n".join(listed))
    with client.messages.stream(model=MODEL, max_tokens=32000, system=AUDIT,
                                messages=[{"role": "user", "content": prompt}],
                                output_config={"effort": "high", "format": {"type": "json_schema", "schema": AUDIT_SCHEMA}}
                                ) as stream:
        message = stream.get_final_message()
    done = []
    for c in json.loads(next(b.text for b in message.content if b.type == "text"))["corrections"]:
        ok = apply(insights, c)
        done.append(c | {"applied": ok})
    return done


def apply(insights, c):
    """Make one correction if it is what the audit may change: a host's name in a teller or recommender, or the
    credit in a joke or core idea, with its quotes and nearly every other word kept. True if it was made."""
    m = re.fullmatch(r"([SRJC])0*(\d+)", c["id"].strip())
    letter, i = (m[1], int(m[2])) if m else ("", 0)
    kind, field = {"S": ("stories", "teller"), "R": ("recommendations", "recommender"),
                   "J": ("jokes_and_cultural_references", "content"), "C": ("core_ideas", "explanation")}.get(letter, ("", ""))
    items = insights.get(kind, [])
    x = items[i - 1] if 0 < i <= len(items) else None
    if x is None or c["field"] != field or c["value"] == x.get(field):
        return False
    if field in ("teller", "recommender"):
        ok = c["value"] in HOSTS
    else:
        plain = lambda text: re.sub(r"\b(Amit|Ajay)( (Varma|Shah))?('s)?\b", " ", text).lower().split()
        quoted = lambda text: " ".join(re.findall(r"(?:(?<=\s)|^)'(.+?)'(?=[\s.,;:!?)]|$)", text)).lower().split()
        ok = (difflib.SequenceMatcher(None, plain(x[field]), plain(c["value"]), autojunk=False).ratio() >= 0.8
              and quoted(x[field]) == quoted(c["value"]))
    if ok:
        x[field] = c["value"]
    return ok


def adjudicate(client, n, again=False):
    path = os.path.join(TRANSCRIPTS, f"{n:03d}.json")
    transcript = load(path)
    settled = transcript["metadata"]["speakerLabels"]
    if settled.endswith(NOTE) and not again:
        return None
    old = load(os.path.join(WORK, "fluidaudio", f"{n:03d}.json"))
    words = [w for seg in transcript["segments"] for w in seg["words"]]
    labels = [seg["speaker"] for seg in transcript["segments"] for _ in seg["words"]]
    fluid = fluid_labels(old, words, labels)
    both = [(s, f) for s, f in zip(labels, fluid) if s in HOSTS and f in HOSTS]
    if not both:  # nothing to compare against
        return None
    agreement = sum(s == f for s, f in both) / len(both)
    asked = asked_before(n) if settled.endswith(LONG_NOTE) and not again else []
    todo = [(lo, hi) for lo, hi in disputes(words, labels, fluid)
            if not any(words[lo]["startTime"] < b and words[hi - 1]["endTime"] > a for a, b in asked)]
    if not todo:
        return None
    title = load(os.path.join(METADATA, f"{n:03d}.json"))["title"].split("|")[0].strip()
    decisions, changed = [], []
    for lo, hi in todo:
        verdict = ask(client, title, words, labels, fluid, lo, hi)
        seconds = round(words[hi - 1]["endTime"] - words[lo]["startTime"], 1)
        decisions.append({"start": words[lo]["startTime"], "seconds": seconds, "voiceprints": labels[lo],
                          "fluidaudio": fluid[lo], **verdict})
        if verdict["speaker"] in HOSTS and verdict["speaker"] != labels[lo]:
            changed.append((lo, hi, labels[lo]))
            labels[lo:hi] = [verdict["speaker"]] * (hi - lo)
    segments = []
    for w, s in zip(words, labels):
        if not segments or segments[-1]["speaker"] != s:
            segments.append({"speaker": s, "words": []})
        segments[-1]["words"].append(w)
    transcript["segments"] = [{"speaker": s["speaker"], "startTime": s["words"][0]["startTime"],
                               "endTime": s["words"][-1]["endTime"], "text": " ".join(w["word"] for w in s["words"]),
                               "words": s["words"]} for s in segments]
    base = settled[:-len(LONG_NOTE)] if settled.endswith(LONG_NOTE) else settled
    transcript["metadata"]["speakerLabels"] = base if base.endswith(NOTE) else base + NOTE
    transcript["metadata"]["speakers"] = sorted({s["speaker"] for s in segments})
    both = [(s, f) for s, f in zip(labels, fluid) if s in HOSTS and f in HOSTS]
    qc = {"episode": n, "agreement_before": round(agreement, 4),
          "agreement_after": round(sum(s == f for s, f in both) / max(1, len(both)), 4), "decisions": decisions}
    insights_path = os.path.join(INSIGHTS, f"{n:03d}.json")
    insights = load(insights_path)
    keep = insights.get("source", {}).get("speakers") == settled  # extracted from the labels just settled: fix, don't redo
    if keep:
        try:
            qc["audit"] = audit(client, title, insights, words, labels, changed) if changed else []
            insights["source"]["speakers"] = transcript["metadata"]["speakerLabels"]
        except Exception as e:  # the insights will be extracted again instead
            keep, qc["audit_error"] = False, f"{type(e).__name__}: {e}"
    for obj, out in ((transcript, path), (insights, insights_path)) if keep else ((transcript, path),):
        with open(out + ".tmp", "w", encoding="utf-8") as f:  # written together, so the extractor never sees one alone
            f.write(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")
        os.replace(out + ".tmp", out)
    with open(os.path.join(WORK, "adjudicate-qc.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(qc, ensure_ascii=False) + "\n")
    return qc


def settle(client, n, again):
    try:
        return adjudicate(client, n, again)
    except Exception as e:  # one bad episode shouldn't stop the rest
        return {"episode": n, "error": f"{type(e).__name__}: {e}", "decisions": []}


def main(args):
    again = "--again" in args
    episodes = [int(a) for a in args if not a.startswith("--")] or range(1, 129)
    with open(os.path.join(WORK, ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=900)
    ready = []
    for n in episodes:  # transcribed on the homelab and extracted; the extractor settles the rest before extracting
        labels = load(os.path.join(TRANSCRIPTS, f"{n:03d}.json"))["metadata"].get("speakerLabels", "")
        if "adapted per episode" in labels and load(os.path.join(INSIGHTS, f"{n:03d}.json")).get("source", {}).get("speakers") == labels:
            ready.append(n)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for qc in pool.map(lambda n: settle(client, n, again), ready):
            if qc:
                print(json.dumps({k: v for k, v in qc.items() if k not in ("decisions", "audit")} | {
                    "settled": sum(d["speaker"] == d["fluidaudio"] for d in qc["decisions"]),
                    "kept": sum(d["speaker"] == d["voiceprints"] for d in qc["decisions"]),
                    "unsure": sum(d["speaker"] == "unsure" for d in qc["decisions"]),
                    "fixed": [c["id"] for c in qc.get("audit", []) if c["applied"]]}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
