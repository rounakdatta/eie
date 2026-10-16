#!/usr/bin/env python3
"""Settle long speaker disagreements between the voiceprint labels and FluidAudio's diarization.

  python3 scripts/adjudicate.py [N ...]   # episodes whose labels agree with FluidAudio's on under 95% of words
  python3 scripts/adjudicate.py --again N # look again at an episode already settled

Voiceprints can mistake a host for the other when his sound changes, as when he presents his
screen (Ajay's Unix demo in Episode 32). FluidAudio, which clusters within the episode, usually
gets those stretches right but misses short interjections that the voiceprints catch. So the
voiceprint labels stand, except where the two disagree for at least MIN_STRETCH seconds. There
Claude reads the passage in context and decides who is speaking: who is addressed by name, what
the speaker says about himself, how the conversation flows.

Needs `pip install anthropic numpy`; Claude is reached through the auth2api gateway, with its
key in work/.auth2api-key.
"""
import collections
import json
import os
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
AGREEMENT, MIN_STRETCH = 0.95, 5.0
NOTE = "; long disagreements with FluidAudio settled by Claude"
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


def adjudicate(client, n, again=False):
    path = os.path.join(TRANSCRIPTS, f"{n:03d}.json")
    transcript = load(path)
    if transcript["metadata"]["speakerLabels"].endswith(NOTE) and not again:
        return None
    old = load(os.path.join(WORK, "fluidaudio", f"{n:03d}.json"))
    words = [w for seg in transcript["segments"] for w in seg["words"]]
    labels = [seg["speaker"] for seg in transcript["segments"] for _ in seg["words"]]
    fluid = fluid_labels(old, words, labels)
    both = [(s, f) for s, f in zip(labels, fluid) if s in HOSTS and f in HOSTS]
    agreement = sum(s == f for s, f in both) / max(1, len(both))
    if agreement >= AGREEMENT:
        return None
    title = load(os.path.join(METADATA, f"{n:03d}.json"))["title"].split("|")[0].strip()
    decisions = []
    for lo, hi in disputes(words, labels, fluid):
        verdict = ask(client, title, words, labels, fluid, lo, hi)
        seconds = round(words[hi - 1]["endTime"] - words[lo]["startTime"], 1)
        decisions.append({"start": words[lo]["startTime"], "seconds": seconds, "voiceprints": labels[lo],
                          "fluidaudio": fluid[lo], **verdict})
        if verdict["speaker"] in HOSTS:
            labels[lo:hi] = [verdict["speaker"]] * (hi - lo)
    segments = []
    for w, s in zip(words, labels):
        if not segments or segments[-1]["speaker"] != s:
            segments.append({"speaker": s, "words": []})
        segments[-1]["words"].append(w)
    transcript["segments"] = [{"speaker": s["speaker"], "startTime": s["words"][0]["startTime"],
                               "endTime": s["words"][-1]["endTime"], "text": " ".join(w["word"] for w in s["words"]),
                               "words": s["words"]} for s in segments]
    if not transcript["metadata"]["speakerLabels"].endswith(NOTE):
        transcript["metadata"]["speakerLabels"] += NOTE
    transcript["metadata"]["speakers"] = sorted({s["speaker"] for s in segments})
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(json.dumps(transcript, indent=2, ensure_ascii=False) + "\n")
    os.replace(path + ".tmp", path)
    both = [(s, f) for s, f in zip(labels, fluid) if s in HOSTS and f in HOSTS]
    qc = {"episode": n, "agreement_before": round(agreement, 4),
          "agreement_after": round(sum(s == f for s, f in both) / max(1, len(both)), 4), "decisions": decisions}
    with open(os.path.join(WORK, "adjudicate-qc.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(qc, ensure_ascii=False) + "\n")
    return qc


def main(args):
    again = "--again" in args
    episodes = [int(a) for a in args if not a.startswith("--")] or range(1, 129)
    with open(os.path.join(WORK, ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=900)
    for n in episodes:
        meta = load(os.path.join(TRANSCRIPTS, f"{n:03d}.json"))["metadata"]
        if "adapted per episode" not in meta.get("speakerLabels", ""):
            continue  # not transcribed yet
        qc = adjudicate(client, n, again)
        if qc:
            print(json.dumps({k: v for k, v in qc.items() if k != "decisions"} | {
                "settled": collections.Counter(d["speaker"] == d["fluidaudio"] for d in qc["decisions"])[True],
                "kept": collections.Counter(d["speaker"] == d["voiceprints"] for d in qc["decisions"])[True],
                "unsure": sum(d["speaker"] == "unsure" for d in qc["decisions"])}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
