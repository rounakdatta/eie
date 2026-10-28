#!/usr/bin/env python3
"""Hooks for the search: for every place in an edition (spots.py), the words a reader might use for it
later, half-remembering it. A search for "the push-ups penance" or "where they said cartels always
break" then meets the piece even where the copy itself used other words.

  python3 site/search/hooks.py 45 46     # these editions
  python3 site/search/hooks.py --all     # every edition with no hooks yet

Writes site/search/hooks/NNN.json: {"<anchor>": ["phrase", ...]}. One call to Claude per edition, through
auth2api (key in work/.auth2api-key); a rate limit is waited out, not failed on. Needs anthropic (work/venv).
"""
import json
import os
import sys
import time

import anthropic

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
OUT = os.path.join(HERE, "hooks")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
sys.path.insert(0, HERE)
from spots import spots  # noqa: E402

BRIEF = """Below are the pieces of one edition of a newspaper made from Episode {n} of the podcast Everything
is Everything, in which Amit Varma and Ajay Shah talk about economics, history, ideas and their lives.
The episode was called “{title}”.

Later, a reader will try to find one of these pieces by describing it from memory: vaguely, in their own
words, often wrongly in the details. For example: “the guy who did push-ups as penance”, “where they
said cartels always break down”, “that book about cooperation and the prisoner's dilemma”, “Ajay's story
about his father's factory”, “the joke about the economist and the lamppost”.

For each piece, write the phrases such a reader might type. Cover:
- the gist in plain, everyday words, and as a question someone might ask ("why do cartels fail");
- the people, places, things, dates and numbers in it, and who told it (Amit or Ajay);
- the ideas it is an example of, by their usual names and their synonyms (a story about a coat and
  the Nile floods is "post hoc fallacy", "correlation is not causation", "superstition");
- how it might be misremembered, and what it might be confused with.
Do not repeat the headline word for word. Each phrase is at most 12 words. Give 8 phrases for a lead,
story, opinion, brief, box or thought; 4 for a number, word, laugh or shelf item.

Reply with JSON alone: {{"hooks": {{"<anchor>": ["...", "..."], ...}}}}, every anchor below included.

The pieces:
{pieces}"""


def trim(text, words):
    w = text.split()
    return " ".join(w[:words]) + (" …" if len(w) > words else "")


def ask(client, prompt):
    for wait in [300, 600, 1200, 1800, 1800, 1800, None]:   # the subscription's rate limit is waited out
        try:
            m = client.messages.create(model=MODEL, max_tokens=24000, messages=[{"role": "user", "content": prompt}])
            text = "".join(b.text for b in m.content if b.type == "text")
            return json.loads(text[text.index("{"):text.rindex("}") + 1]), m.usage
        except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError):
            if wait is None:
                raise
            print(json.dumps({"waiting": wait}), flush=True)
            time.sleep(wait)


def edition(client, n, titles):
    E = json.load(open(os.path.join(SITE, "editions", f"{n:03d}", "edition.json"), encoding="utf-8"))
    S = spots(E, n)
    long = {"lead": 220, "story": 140, "opinion": 140}
    pieces = "\n".join(f"[{s['a']}] ({s['kind']}, page {s['page']}) {s['head']}" + (f" — {s['kicker']}" if s["kicker"] else "")
                       + f": {trim(s['text'], long.get(s['kind'], 80))}" for s in S)
    t0 = time.time()
    for attempt in (1, 2):
        try:
            reply, usage = ask(client, BRIEF.format(n=n, title=titles.get(n, ""), pieces=pieces))
            break
        except ValueError:   # no JSON in the reply: once more
            if attempt == 2:
                raise
    hooks = {a: [h.strip() for h in v if isinstance(h, str) and h.strip()][:10] for a, v in (reply.get("hooks") or {}).items()
             if a in {s["a"] for s in S}}
    os.makedirs(OUT, exist_ok=True)
    tmp = os.path.join(OUT, f"{n:03d}.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(hooks, f, ensure_ascii=False, indent=0)
        f.write("\n")
    os.replace(tmp, os.path.join(OUT, f"{n:03d}.json"))
    return {"edition": n, "spots": len(S), "hooked": len(hooks), "seconds": round(time.time() - t0), "out": usage.output_tokens}


def main(args):
    titles = {e["episode_number"]: e["title"] for e in json.load(open(os.path.join(ROOT, "data", "generated", "episodes.json")))["episodes"]}
    ns = [int(a) for a in args if a.isdigit()] or ([n for n in range(1, 129) if not os.path.exists(os.path.join(OUT, f"{n:03d}.json"))] if "--all" in args else [])
    with open(os.path.join(ROOT, "work", ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=3, timeout=900)
    for n in ns:
        try:
            print(json.dumps(edition(client, n, titles)), flush=True)
        except Exception as e:   # one edition's trouble shouldn't stop the run
            print(json.dumps({"edition": n, "error": f"{type(e).__name__}: {str(e)[:200]}"}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
