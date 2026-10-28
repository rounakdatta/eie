#!/usr/bin/env python3
"""Write an edition's copy with Claude: site/editions/NNN/copy.json.

  python3 site/paper/write.py 1 50 85        # these episodes
  python3 site/paper/write.py --all          # every episode that has no copy yet
  python3 site/paper/write.py --force 12     # again, over an existing copy

Needs the anthropic package (work/venv); Claude is reached through the auth2api gateway, with its key
in work/.auth2api-key. For each episode:

1. a draft, written to BRIEF.md from the episode (its chapters, show notes, insights and transcript),
   with Episode 45's copy as the model to follow;
2. the checks in copydesk.py, everything a machine can check: references, marks, phrases found in the
   transcript, quotes as said, counts, lengths, the crossword's words;
3. a review by a second call, which reads the draft against the transcript as a sub-editor would and
   returns it corrected, with what it changed;
4. the checks again; whatever still fails goes back to the model, twice at most;
5. the crossword's seed, chosen here so that the build lays out the same grid every time.

Every step is logged in work/editions/logs/NNN.json.
"""
import concurrent.futures
import importlib.util
import json
import os
import re
import sys
import threading
import time

import anthropic

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
EDITIONS = os.path.join(SITE, "editions")
LOGS = os.path.join(ROOT, "work", "editions", "logs")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
sys.path.insert(0, SITE)
sys.path.insert(0, HERE)
import build  # noqa: E402
import copydesk as C  # noqa: E402
import crossword  # noqa: E402

_spec = importlib.util.spec_from_file_location("build_paper", os.path.join(HERE, "build-paper.py"))
BP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(BP)
LOCK = threading.Lock()   # the transcript cache in build.py is not built for threads
NAME = {"Amit Varma": "Amit", "Ajay Shah": "Ajay", "other": "Other"}
SPK = ["Amit", "Ajay", "Other"]

REVIEW = """You are the chief sub-editor of the broadsheet described below. A writer has drafted this
episode's edition. Read it against the episode, line by line, as the last person before it is
printed, and return it corrected, whole, in the same shape.

Check, and fix:
- Truth. Every statement, figure, name and date must be in this episode; cut or correct anything
  that isn't. Attributions must be right (trust the insights' attributions over the transcript's
  speaker labels). Slips the hosts made are reported as said, not corrected.
- Quotes. Anything in quotation marks must be what the speaker said, fillers aside. Compare each
  with the transcript; restore the words or drop the quotation marks.
- Marks. Each {ID} must sit after the sentence whose content was said at that moment, and only
  playable items may be marked. Each named moment's phrase must be copied exactly from the
  transcript. A story's start and end must be the first and last words of its telling.
- Headlines and teasers: clear, witty in the Telegraph's way, none repeating another's pun or words.
  The first skyline teaser must be about something Amit said, the second about something Ajay said.
- The crossword: every answer spelt right and fairly clued; every enum right. The quiz: every answer
  right and in the episode.
- Lengths and counts, as the brief sets them; and the problems the automatic checks found, listed
  below, every one.
- Style: British spelling, curly quotes, no em dashes, *titles* in italics, no marks where marks
  are not allowed.

Change only what needs changing; keep what is good. In `changes`, list each change in a short line
(what was wrong, what you did)."""

FIX = """The automatic checks still find these problems in the edition. Fix every one, change nothing
else, and return the whole edition."""


def clock(sec):
    sec = int(sec)
    return f"{sec // 3600}:{sec // 60 % 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60}:{sec % 60:02d}"


def transcript_text(t):
    """The transcript as lines a writer can read and quote from: a timestamp, who, what was said."""
    lines, cur = [], None
    for seg in t.segments:
        who = NAME.get(seg["speaker"], "Other")
        if cur and cur[1] == who and seg["startTime"] - cur[0] < 60:
            cur[2].append(seg["text"].strip())
        else:
            if cur:
                lines.append(f"[{clock(cur[0])}] {cur[1]}: {' '.join(cur[2])}")
            cur = [seg["startTime"], who, [seg["text"].strip()]]
    if cur:
        lines.append(f"[{clock(cur[0])}] {cur[1]}: {' '.join(cur[2])}")
    return "\n".join(lines)


def items_text(items):
    out = []
    for it in items:
        k, iid = it["id"][4], it["id"]
        play = f"playable, {clock(it['at'][0] / 100)}, {SPK[it['spk']]}" if "at" in it else "not playable"
        quote = f" Quote: “{it['quote']}”" if it.get("quote") else ""   # a few insights have none
        if k == "C":
            out.append(f"{iid} [core idea; {play}] {it['concept']}: {it.get('explanation', '')}{quote}")
        elif k == "S":
            out.append(f"{iid} [story told by {it.get('teller', 'the hosts')}; {play}] {it['topic']}: {it.get('summary', '')} "
                       f"Insight: {it.get('insight', '')}{quote}")
        elif k == "R":
            by = f", by {it['creator']}" if it.get("creator") else ""
            out.append(f"{iid} [recommended by {it.get('recommender', 'the hosts')}; {play}] {it['item']} ({it.get('type', 'other')}{by}): {it.get('reason', '')}")
        else:
            out.append(f"{iid} [{it.get('type', 'reference')}; {play}] {it.get('content', '')}")
    return "\n".join(out)


class Episode:
    """What a writer is given of one episode, and what the checks need."""

    def __init__(self, n, archive):
        self.n = n
        with LOCK:
            self.ep = archive.episode(n)
            self.t = build.transcript(n)
        e = self.ep["episode"]
        self.items = {i["id"]: i for i in self.ep["items"]}
        self.chapters = e["chapters"]
        notes = open(os.path.join(ROOT, "data", "original", "descriptions", f"{n:03d}.txt"), encoding="utf-8").read()
        ch = self.chapters
        chapters = "\n".join(
            f"[{i}] {clock(c['start'])} {c['title']} ({clock((ch[i + 1]['start'] if i + 1 < len(ch) else e['seconds']) - c['start'])} long)"
            for i, c in enumerate(ch)) or "(this episode has no chapters: give every section chapter null, and `chapters` an empty list)"
        self.recs = sum(1 for i in self.ep["items"] if i["id"][4] == "R")
        self.jokes = sum(1 for i in self.ep["items"] if i["id"][4] == "J")
        self.context = (
            f"<episode number=\"{n}\">\nTitle: {e['title']}\nReleased: {e['date']}\nLength: {clock(e['seconds'])}\n"
            f"Recommendations on the shelf: {self.recs}, so the laugh lines (funny and refs together) number {C.laughs_for(self.recs, self.jokes)}.\n\n"
            f"Chapters (index, start, title):\n{chapters}\n\nShow notes:\n{notes.strip()}\n\n"
            f"Insights (ID [kind; whether it can be played, when, who]):\n{items_text(self.ep['items'])}\n\n"
            f"Transcript:\n{transcript_text(self.t)}\n</episode>")

    def ctx(self):
        if not hasattr(self, "said"):
            texts = [w[2] for w in self.t.words] + [str(v) for it in self.ep["items"] for k, v in it.items() if isinstance(v, str)]
            self.said = re.sub(r"[^a-z0-9]", "", " ".join(texts).lower())
        words = self.t.words
        near = lambda a, b: " ".join(w[2] for w in words if a <= w[0] <= b)
        return {"n": self.n, "items": self.items, "chapters": self.chapters, "seconds": self.ep["episode"]["seconds"], "recs": self.recs, "jokes": self.jokes,
                "locate": self.t.locate, "time": lambda i: self.t.words[i][0], "said": self.said, "near": near}


def model_edition():
    c45 = json.load(open(os.path.join(EDITIONS, "045", "copy.json"), encoding="utf-8"))
    c45["crossword"] = {k: v for k, v in c45["crossword"].items() if k in ("required", "words")}
    meta = json.load(open(os.path.join(ROOT, "data", "original", "metadata", "045.json"), encoding="utf-8"))
    chapters = ", ".join(f"[{i}] {c['title']}" for i, c in enumerate(meta["chapters"]))
    return (f"<model_edition episode=\"45\">\nEpisode 45's chapters were: {chapters}.\n"
            f"Its edition, made by hand (it has no ~ paragraphs; yours should):\n"
            f"{json.dumps(c45, ensure_ascii=False, indent=1)}\n</model_edition>")


JSON_ONLY = "\n\nReply with the JSON object alone: no preamble, no code fence, nothing after it."


WAITS = [300, 600, 1200, 1800, 1800, 1800, 1800]   # about two and a half hours in all


def patient(call, log, step):
    """A call that waits out the subscription's rate limit instead of failing: five writers at once
    ran into "Rate limited on the configured account", and the work done before it was lost."""
    for wait in WAITS + [None]:
        try:
            return call()
        except (anthropic.RateLimitError, anthropic.InternalServerError) as e:
            if wait is None:
                raise
            log.setdefault("waits", []).append({"step": step, "seconds": wait, "why": str(e)[:120]})
            time.sleep(wait)


def ask(client, system, content, log, step):
    """One call, its reply read as a JSON object. (Structured outputs can't hold the copy's schema,
    so the shape is checked afterwards, by copydesk.shape.) A reply that isn't JSON is asked again."""
    for attempt in (1, 2):
        t0 = time.time()

        def call():
            with client.messages.stream(model=MODEL, max_tokens=110000, system=system + JSON_ONLY,
                                        messages=[{"role": "user", "content": content}], output_config={"effort": "high"}) as stream:
                return stream.get_final_message()
        message = patient(call, log, step)
        u = message.usage
        log["steps"].append({"step": step, "attempt": attempt, "seconds": round(time.time() - t0), "in": u.input_tokens, "out": u.output_tokens,
                             "stop": message.stop_reason})
        text = "".join(b.text for b in message.content if b.type == "text")
        try:
            if message.stop_reason != "end_turn":
                raise ValueError(f"stop_reason {message.stop_reason}")
            return json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError as e:
            log["steps"][-1]["error"] = str(e)[:300]
            log["steps"][-1]["tail"] = text[-600:]   # what came back, for the log
    raise RuntimeError(f"{step}: no JSON after two attempts")


def inspect(copy, ep):
    """A copy as the paper will read it, and what is wrong with it: its shape first, then the rest."""
    bad = C.shape(copy)
    if bad:
        return copy, bad, []
    copy = C.normalize(copy)
    errors, warnings = C.check(copy, ep.ctx())
    return copy, errors, warnings


def problems(errors, warnings):
    return "\n".join([f"- ERROR {e}" for e in errors] + [f"- warning {w}" for w in warnings])


def choose_seed(copy):
    """The crossword seed whose grid holds the most answers, crossed the most, in the tightest box."""
    cw = copy["crossword"]
    words = [(w["answer"],) for w in cw["words"]]
    best = None
    # all the theme words if a grid can hold them, else fewer: a crossword is never worth losing a copy over
    for required in (tuple(cw["required"]), tuple(cw["required"][:6]), tuple(cw["required"][:3]), ()):
        for seed in range(1, 25):
            layout = crossword.build(words, seed=seed, tries=600, max_w=15, max_h=13, required=required)
            if not layout:
                continue
            try:
                BP.check_grid(layout)
            except ValueError:
                continue
            key = (len(layout["placed"]), crossword._score(layout, 1.25))
            if best is None or key > best[0]:
                best = (key, seed, list(required))
        if best:
            break
    if not best:
        raise RuntimeError("crossword: no seed lays out the required words")
    return {"seed": best[1], "maxW": 15, "maxH": 13, "required": best[2], "words": cw["words"]}, best[0][0]


def write(client, n, archive, brief, exemplar, force=False):
    log = {"episode": n, "model": MODEL, "steps": []}
    d = os.path.join(EDITIONS, f"{n:03d}")
    os.makedirs(d, exist_ok=True)
    # two writers at once share the list: an episode is claimed before it is begun, and skipped if done
    if not force and os.path.exists(os.path.join(d, "copy.json")):
        return {"episode": n, "skipped": "already written"}
    claim = os.path.join(d, ".writing")
    try:
        os.close(os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        return {"episode": n, "skipped": "being written by another writer"}
    try:
        return _write(client, n, archive, brief, exemplar, log)
    except Exception as e:   # keep the log of a failed episode: it says what went wrong
        log["failed"] = f"{type(e).__name__}: {e}"
        with open(os.path.join(LOGS, f"{n:03d}.failed.json"), "w", encoding="utf-8") as f:
            json.dump(log, f, ensure_ascii=False, indent=1)
        with LOCK:
            build._transcripts.pop(n, None)
        raise
    finally:
        os.remove(claim)


def _write(client, n, archive, brief, exemplar, log):
    began = time.time()
    ep = Episode(n, archive)
    ask_ = lambda system, content, step: ask(client, system, content, log, step)
    draft = ask_(brief, f"{ep.context}\n\n{exemplar}\n\nWrite the edition for Episode {n}, as JSON in the model edition's shape.", "draft")
    draft, errors, warnings = inspect(draft, ep)
    log["draft"] = {"errors": errors, "warnings": warnings}
    reviewed = ask_(f"{REVIEW}\n\n<brief>\n{brief}\n</brief>",
                    f"{ep.context}\n\n<draft>\n{json.dumps(draft, ensure_ascii=False, indent=1)}\n</draft>\n\n"
                    f"The automatic checks found:\n{problems(errors, warnings) or '- nothing'}\n\n"
                    'Return {"changes": [...], "copy": {...the corrected edition, whole, in the same shape...}}.', "review")
    copy = reviewed.get("copy", reviewed)
    log["changes"] = reviewed.get("changes", [])
    return finish(client, ep, copy, log, brief, began, draft)


def finish(client, ep, copy, log, brief, began, draft=None, rounds=2):
    """The checks again, what still fails back to the model (twice at most), the crossword's seed,
    and the copy and its log saved."""
    n = ep.n
    ask_ = lambda system, content, step: ask(client, system, content, log, step)
    for attempt in range(1, rounds + 1):
        copy, errors, warnings = inspect(copy, ep)
        log[f"after{attempt}"] = {"errors": errors, "warnings": warnings}
        if not errors:
            break
        copy = ask_(f"{FIX}\n\n<brief>\n{brief}\n</brief>",
                    f"{ep.context}\n\n<edition>\n{json.dumps(copy, ensure_ascii=False, indent=1)}\n</edition>\n\n"
                    f"Problems:\n{problems(errors, [])}\n\nReturn the whole edition.", f"fix{attempt}")
    copy, errors, warnings = inspect(copy, ep)
    if C.shape(copy):
        raise RuntimeError(f"the copy's shape is still wrong: {C.shape(copy)[:5]}")
    log["final"] = {"errors": errors, "warnings": warnings}
    copy["crossword"], placed = choose_seed(copy)
    log["crossword"] = {"seed": copy["crossword"]["seed"], "placed": placed, "of": len(copy["crossword"]["words"])}
    d = os.path.join(EDITIONS, f"{n:03d}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "copy.json.tmp"), "w", encoding="utf-8") as f:   # whole or not at all: media.py watches for it
        json.dump(copy, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(os.path.join(d, "copy.json.tmp"), os.path.join(d, "copy.json"))
    log["seconds"] = round(time.time() - began)
    with LOCK:   # a transcript is tens of MB in memory; 128 of them would not fit the pod
        build._transcripts.pop(n, None)
    with open(os.path.join(LOGS, f"{n:03d}.json"), "w", encoding="utf-8") as f:
        json.dump({**log, **({"draft_copy": draft} if draft else {})}, f, ensure_ascii=False, indent=1)
    return {"episode": n, "seconds": log["seconds"], "errors": len(errors), "warnings": len(warnings),
            "changes": len(log.get("changes", [])), "crossword": f"{placed}/{len(copy['crossword']['words'])}"}


def recheck(client, n, archive, brief):
    """An existing copy through today's checks: only what fails goes back to the model."""
    began = time.time()
    path = os.path.join(LOGS, f"{n:03d}.json")
    log = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {"episode": n, "model": MODEL, "steps": []}
    draft = log.pop("draft_copy", None)
    log.setdefault("rechecks", []).append(time.strftime("%Y-%m-%d %H:%M"))
    ep = Episode(n, archive)
    copy = json.load(open(os.path.join(EDITIONS, f"{n:03d}", "copy.json"), encoding="utf-8"))
    return finish(client, ep, copy, log, brief, began, draft, rounds=3)   # a missing field hides the rest until it's fixed


def main(args):
    force = "--force" in args
    every = "--all" in args
    again = "--recheck" in args
    reverse = "--reverse" in args
    workers = int(next((a.split("=")[1] for a in args if a.startswith("--workers=")), "2"))
    episodes = [int(a) for a in args if a.isdigit()] or (range(1, 129) if every else [])
    have = lambda n: os.path.exists(os.path.join(EDITIONS, f"{n:03d}", "copy.json"))
    todo = [n for n in episodes if have(n)] if again else [n for n in episodes if force or not have(n)]
    todo = todo[::-1] if reverse else todo
    os.makedirs(LOGS, exist_ok=True)
    with open(os.path.join(ROOT, "work", ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=3600)
    brief = open(os.path.join(HERE, "BRIEF.md"), encoding="utf-8").read()
    exemplar = model_edition()
    archive = BP.Archive()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {(pool.submit(recheck, client, n, archive, brief) if again else pool.submit(write, client, n, archive, brief, exemplar, force)): n for n in todo}
        for fut in concurrent.futures.as_completed(futures):
            n = futures[fut]
            try:
                print(json.dumps(fut.result(), ensure_ascii=False), flush=True)
            except Exception as e:  # one bad episode shouldn't stop the run
                print(json.dumps({"episode": n, "error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
