#!/usr/bin/env python3
"""Re-extract each episode's insights from its new transcript, following GEMINI.md.

  python3 scripts/extract.py [N ...]   # every episode with a finished transcript; resumable
  python3 scripts/extract.py --wait    # keep going as the transcription run finishes episodes
  python3 scripts/extract.py --force N # redo episode N even if it's already extracted

Speaker disagreements of 1 s or more are settled first (scripts/adjudicate.py). Then Claude Opus 5.5
reads the speaker-labelled transcript, the show notes and the previous
extraction (a checklist of candidates, never a source) and returns the four kinds of insight
in the existing schema. Quotes, speakers and recommendations are then checked against the
transcript and show notes; whatever fails goes back to the model once, and a quote that still
fails is dropped.

Needs `pip install anthropic`. Claude is reached through the auth2api gateway, with its key in
work/.auth2api-key.
"""
import concurrent.futures
import datetime
import difflib
import json
import os
import re
import sys
import time

import anthropic

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adjudicate  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPTS = os.path.join(ROOT, "data", "original", "transcripts")
DESCRIPTIONS = os.path.join(ROOT, "data", "original", "descriptions")
METADATA = os.path.join(ROOT, "data", "original", "metadata")
INSIGHTS = os.path.join(ROOT, "data", "generated", "insights")
WORK = os.path.join(ROOT, "work")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
READY = ("nvidia/parakeet-tdt-0.6b-v3", "adapted per episode")  # transcript metadata of a finished episode
HOSTS = ("Amit Varma", "Ajay Shah")
TYPES = ["book", "essay", "article", "paper", "film", "tv", "song", "album", "podcast", "podcast episode",
         "course", "newsletter", "speech", "poem", "tool", "other"]


def item(properties, enums=None):
    """A JSON-schema object of required string fields, some restricted to a list of values."""
    fields = {p: {"type": "string"} for p in properties} | {
        p: {"type": "string", "enum": values} for p, values in (enums or {}).items()}
    return {"type": "object", "properties": fields, "required": list(properties), "additionalProperties": False}


SCHEMA = {"type": "object", "additionalProperties": False,
          "required": ["stories", "recommendations", "core_ideas", "jokes_and_cultural_references"],
          "properties": {
              "stories": {"type": "array", "items": item(["teller", "topic", "summary", "insight", "quote"])},
              "recommendations": {"type": "array", "items": item(
                  ["recommender", "item", "type", "creator", "context", "reason"], {"type": TYPES})},
              "core_ideas": {"type": "array", "items": item(["concept", "explanation", "quote"])},
              "jokes_and_cultural_references": {"type": "array", "items": item(
                  ["type", "content"], {"type": ["humor", "reference"]})}}}

OUTPUT_RULES = """
## Output for this run

Return JSON with four arrays: stories, recommendations, core_ideas, jokes_and_cultural_references.
- stories: teller, topic (a short title), summary (what happened, concretely), insight (what it reveals), quote.
- recommendations: recommender, item, type, creator, context (where and how it came up), reason (why they recommend it).
- core_ideas: concept, explanation, quote.
- jokes_and_cultural_references: type ("humor" or "reference"), content (the moment itself, with the actual words where they matter).

Ground rules:
- The transcript labels every paragraph with its speaker, found by voice. Tellers and recommenders are those
  speakers' bare names ("Amit Varma", "Ajay Shah"). Credit a third person only if the transcript or show notes
  name them. When a host retells someone else's story, the teller is still the host.
- The transcript is machine-made, so names and rare words are sometimes misheard ("the scene and the unseen" is
  Amit's other podcast, The Seen and the Unseen). Spell names as the show notes do, everywhere including quotes.
- A quote reproduces the speaker's words from the transcript. Repair transcription errors as above, but never
  paraphrase. Leave quote empty ("") when no line is worth quoting.
- Use creator "" when no creator applies. Show-notes links count as recommendations when they point to a real
  work, as the earlier pass treated them; keep the hosts' standing self-promotion (their courses, newsletter,
  books, other shows) only where the episode actually discusses it.
- Everything must be supported by this episode's transcript or show notes. Do not add facts from your own
  knowledge, and do not include a reference the episode doesn't actually make.
- The previous extraction came from an earlier pass over a worse transcript. Treat it as a checklist of candidates:
  verify each one against this transcript, keep only what holds, fix what it got wrong (speakers, details), and
  write everything in your own words. It is not a source.
"""


def gemini_rules():
    with open(os.path.join(ROOT, "GEMINI.md"), encoding="utf-8") as f:
        text = f.read()
    return text[text.index("## Once transcribed and diarized files are ready"):]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clock(t):
    t = int(t)
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}"


def render(transcript):
    """Paragraphs of '[h:mm:ss] Speaker: text', breaking long turns about once a minute."""
    out = []
    for seg in transcript["segments"]:
        name = seg["speaker"] if seg["speaker"] in HOSTS else "Other speaker"
        para, start = [], None
        for w in seg["words"]:
            if start is None:
                start = w["startTime"]
            para.append(w["word"])
            if w["startTime"] - start > 60 and w["word"].endswith((".", "?", "!")):
                out.append(f"[{clock(start)}] {name}: {' '.join(para)}")
                para, start = [], None
        if para:
            out.append(f"[{clock(start)}] {name}: {' '.join(para)}")
    return "\n\n".join(out)


def words(text):
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split()


class Grounding:
    """Checks a draft against the episode's own text."""

    def __init__(self, transcript_text, notes):
        self.tokens = words(transcript_text)
        self.trigrams = {}
        for i in range(len(self.tokens) - 2):
            self.trigrams.setdefault(tuple(self.tokens[i:i + 3]), []).append(i)
        self.vocabulary = set(self.tokens) | set(words(notes))

    def quoted(self, quote):
        """True if the quote matches a stretch of the transcript at 80% or better, word for word."""
        q = words(quote)
        if len(q) < 3:
            return True
        starts = {}
        for i in range(len(q) - 2):
            for j in self.trigrams.get(tuple(q[i:i + 3]), []):
                starts[j - i] = starts.get(j - i, 0) + 1
        for start, _ in sorted(starts.items(), key=lambda kv: -kv[1])[:5]:
            span = self.tokens[max(0, start):max(0, start) + len(q)]
            if difflib.SequenceMatcher(None, q, span, autojunk=False).ratio() >= 0.8:
                return True
        return False

    def mentioned(self, rec):
        """True if most of the item's distinctive words, or its creator's surname, occur in the episode."""
        key = [w for w in words(rec["item"]) if len(w) > 3 and w not in STOP]
        surname = words(rec.get("creator") or "")[-1:]
        if surname and surname[0] in self.vocabulary:
            return True
        return not key or sum(w in self.vocabulary for w in key) >= max(1, len(key) / 2)

    def problems(self, draft):
        found = []
        for kind, field in (("stories", "quote"), ("core_ideas", "quote")):
            for i, x in enumerate(draft[kind], 1):
                if x[field] and not self.quoted(x[field]):
                    found.append(f"{kind} #{i} ({x.get('topic') or x.get('concept')}): the quote is not in the "
                                 f"transcript: {x[field]!r}")
        for i, x in enumerate(draft["stories"], 1):
            if x["teller"] not in HOSTS and not set(words(x["teller"])) <= self.vocabulary:
                found.append(f"stories #{i}: teller {x['teller']!r} is neither a host nor named in the episode")
        for i, x in enumerate(draft["recommendations"], 1):
            if x["recommender"] not in HOSTS and not set(words(x["recommender"])) <= self.vocabulary:
                found.append(f"recommendations #{i}: recommender {x['recommender']!r} is neither a host nor named")
            if not self.mentioned(x):
                found.append(f"recommendations #{i}: {x['item']!r} is not in the transcript or show notes")
        return found


STOP = set("the and with from that this what your their about into over under than then them they have will "
           "episode everything amit ajay varma shah".split())


def ask(client, system, messages):
    with client.messages.stream(model=MODEL, max_tokens=64000, system=system, messages=messages,
                                output_config={"effort": "xhigh", "format": {"type": "json_schema", "schema": SCHEMA}}
                                ) as stream:
        message = stream.get_final_message()
    if message.stop_reason != "end_turn":
        raise RuntimeError(f"stop_reason {message.stop_reason}")
    return message, json.loads(next(b.text for b in message.content if b.type == "text"))


def extract(client, n):
    began = time.time()
    adjudicate.adjudicate(client, n)  # settle speaker disagreements with FluidAudio first
    transcript = load(os.path.join(TRANSCRIPTS, f"{n:03d}.json"))
    meta = load(os.path.join(METADATA, f"{n:03d}.json"))
    with open(os.path.join(DESCRIPTIONS, f"{n:03d}.txt"), encoding="utf-8") as f:
        notes = f.read()
    previous = load(os.path.join(WORK, "previous-insights", f"{n:03d}.json"))
    text = render(transcript)
    title = re.split(r"\s*\|\s*", meta["title"])[0]
    system = ("You curate the podcast Everything is Everything, hosted by Amit Varma and Ajay Shah, for a curious "
              "reader. These are the project's instructions:\n\n" + gemini_rules() + OUTPUT_RULES)
    prompt = (f"Episode {n}: {title} (released {meta['release_date']})\n\n"
              f"<show_notes>\n{notes}\n</show_notes>\n\n<transcript>\n{text}\n</transcript>\n\n"
              f"<previous_extraction>\n{json.dumps({k: previous[k] for k in SCHEMA['required']}, ensure_ascii=False)}"
              f"\n</previous_extraction>\n\n"
              "Extract this episode's stories, recommendations, core ideas, and jokes and cultural references, "
              "following the instructions above.")
    messages = [{"role": "user", "content": prompt}]
    message, draft = ask(client, system, messages)
    usage = [message.usage]
    grounding = Grounding(text, notes)
    first = grounding.problems(draft)
    if first:
        messages += [{"role": "assistant", "content": message.content},
                     {"role": "user", "content": "A check against the transcript and show notes found these problems:\n- "
                      + "\n- ".join(first) + "\n\nReturn the complete corrected JSON. Quote the transcript exactly or "
                      "leave the quote empty; remove anything the episode doesn't support; keep everything else."}]
        message, draft = ask(client, system, messages)
        usage.append(message.usage)
    remaining = grounding.problems(draft)
    dropped = 0
    for kind in ("stories", "core_ideas"):
        for x in draft[kind]:
            if x["quote"] and not grounding.quoted(x["quote"]):
                x["quote"], dropped = "", dropped + 1
    for kind in ("stories", "core_ideas"):
        for x in draft[kind]:
            if not x["quote"]:
                del x["quote"]
    for x in draft["recommendations"]:
        if not x["creator"]:
            del x["creator"]
    out = {"episode_title": title, "episode_number": n, "release_date": meta["release_date"],
           "episode_url": meta["url"], **draft,
           "source": {"transcript": transcript["metadata"]["asr"], "speakers": transcript["metadata"]["speakerLabels"],
                      "model": MODEL, "extracted": datetime.date.today().isoformat()}}
    path = os.path.join(INSIGHTS, f"{n:03d}.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    os.replace(path + ".tmp", path)
    qc = {"episode": n, "counts": {k: len(draft[k]) for k in SCHEMA["required"]},
          "problems_first": len(first), "problems_after": len(remaining), "quotes_dropped": dropped,
          "unverified": [p for p in remaining if "quote is not" not in p],
          "input_tokens": sum(u.input_tokens for u in usage), "output_tokens": sum(u.output_tokens for u in usage),
          "minutes": round((time.time() - began) / 60, 1)}
    with open(os.path.join(WORK, "extract-qc.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(qc, ensure_ascii=False) + "\n")
    return qc


def pending(episodes, force=False):
    todo = []
    for n in episodes:
        meta = load(os.path.join(TRANSCRIPTS, f"{n:03d}.json"))["metadata"]
        ready = meta.get("asr", "").startswith(READY[0]) and READY[1] in meta.get("speakerLabels", "")
        done = load(os.path.join(INSIGHTS, f"{n:03d}.json")).get("source", {}).get("speakers") == meta.get("speakerLabels")
        if ready and (force or not done):
            todo.append(n)
    return todo


def main(args):
    wait, force = "--wait" in args, "--force" in args
    episodes = [int(a) for a in args if not a.startswith("--")] or range(1, 129)
    with open(os.path.join(WORK, ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=1800)
    while True:
        todo, force = pending(episodes, force), False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for n, future in [(n, pool.submit(extract, client, n)) for n in todo]:
                try:
                    print(json.dumps(future.result(), ensure_ascii=False), flush=True)
                except Exception as e:  # one bad episode shouldn't stop the run
                    print(json.dumps({"episode": n, "error": f"{type(e).__name__}: {e}"}), flush=True)
        if not wait or not pending(episodes) and all(
                load(os.path.join(INSIGHTS, f"{n:03d}.json")).get("source") for n in episodes):
            break
        time.sleep(600)


if __name__ == "__main__":
    main(sys.argv[1:])
