#!/usr/bin/env python3
"""Cross-references between editions, as a newspaper prints them ("see page 3"): where a story, an idea, a
person or a book in one edition is the same one another edition takes up, a mark at that point leads to
the other place.

  python3 site/search/xrefs.py 45 46     # these editions
  python3 site/search/xrefs.py --all     # every edition with no cross-references yet

For each piece of prose in an edition (the lead, the stories, the opinion sections, In Brief, the side box,
the thought for the day: spots.py), candidates from the other editions come by their words and hooks
(the same BM25 the desk uses) and by the archive's big ideas (insights the analysis tied together across
episodes). Claude reads each edition's pieces with their candidates and keeps only real cross-references:
the same story told again, the same idea or framework argued elsewhere, the same person, book or event
at the heart of both. It says after which words of the piece the mark belongs, and what the two share.

Writes site/search/xrefs/NNN.json: [{"a": anchor here, "to": "66#miracle", "phrase": "…", "label": "…"}],
the phrase checked to be in the piece. One call to Claude an edition, through auth2api (work/.auth2api-key).
"""
import collections
import glob
import json
import math
import os
import re
import sys
import time

import anthropic

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
OUT = os.path.join(HERE, "xrefs")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
PROSE = {"lead", "story", "opinion", "brief", "box", "thought"}
sys.path.insert(0, HERE)
from spots import spots, clean  # noqa: E402
from server import words  # noqa: E402  (the desk's own tokens: stemmed, no stop words)

BRIEF = """Below are the pieces of one edition of a newspaper made from Episode {n} of the podcast Everything is
Everything, in which Amit Varma and Ajay Shah talk about economics, history, ideas and their own lives.
Each piece is followed by places in OTHER editions of the same newspaper that might take up the same thing.

A newspaper prints a cross-reference ("see No. 66, page 3") where a reader of this piece would truly want
the other one: the same story told again, the same idea or framework argued in a new setting, the same
person, book or event at the heart of both. Not a word or a name they merely share, not a passing mention,
not two pieces that are only on the same broad subject. For each piece choose at most two, the strongest
first, or none: most pieces have none or one.

For each choice give:
- "a": the piece's anchor, "to": the other place's id (as given, like "66#miracle");
- "phrase": the words in THIS piece, copied exactly (2 to 8 words), after which the reference should sit:
  where the shared thing is named or first appears;
- "label": 3 to 7 words naming what the two share, for the reader ("Hayek's pencil, again", "the Bengal
  famine", "Ajay's father's factory").

Reply with JSON alone: {{"refs": [{{"a": "...", "to": "...", "phrase": "...", "label": "..."}}]}}

{pieces}"""


def trim(text, n):
    w = text.split()
    return " ".join(w[:n]) + (" …" if len(w) > n else "")


def norm(s):
    s = clean(s).replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


class Prose:
    """Every piece of prose in every edition, by its words and hooks (BM25), and by its big ideas."""

    def __init__(self):
        self.spots, self.by = [], {}
        for f in sorted(glob.glob(os.path.join(SITE, "editions", "[0-9][0-9][0-9]", "edition.json"))):
            n = int(f.split(os.sep)[-2])
            hp = os.path.join(HERE, "hooks", f"{n:03d}.json")
            hooks = json.load(open(hp, encoding="utf-8")) if os.path.exists(hp) else {}
            for s in spots(json.load(open(f, encoding="utf-8")), n):
                if s["kind"] in PROSE:
                    s["ep"], s["hooks"] = n, hooks.get(s["a"], [])
                    self.spots.append(s)
                    self.by[s["id"]] = s
        self.docs = [collections.Counter(words(s["head"]) * 3 + words(s["kicker"]) * 2 + words(" ".join(s["hooks"])) * 2 + words(s["text"]))
                     for s in self.spots]
        self.lens = [sum(d.values()) for d in self.docs]
        self.avg = sum(self.lens) / len(self.lens)
        df = collections.Counter(t for d in self.docs for t in d)
        N = len(self.docs)
        self.idf = {t: math.log(1 + (N - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        # the big ideas: an insight of one episode tied by the analysis to insights of others
        big = json.load(open(os.path.join(ROOT, "data", "generated", "analysis", "big_ideas.json"), encoding="utf-8"))["ideas"]
        self.ideas = collections.defaultdict(set)
        for idea in big:
            for src in idea["sources"] + [idea["quote"]["source"]]:
                self.ideas[src].add(idea["id"])
        self.by_idea = collections.defaultdict(list)
        for s in self.spots:
            for i in self.ideas.get(s.get("item") or "", ()):
                self.by_idea[i].append(s)

    def score(self, q, i):
        d, s = self.docs[i], 0.0
        for t in q:
            f = d.get(t)
            if f:
                s += self.idf[t] * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * self.lens[i] / self.avg))
        return s

    def candidates(self, s, k=10):
        q = set(words(s["head"]) + words(s["kicker"]) + words(" ".join(s["hooks"])))
        ranked = sorted(((self.score(q, i), t) for i, t in enumerate(self.spots) if t["ep"] != s["ep"]), key=lambda x: -x[0])
        out, per = [], collections.Counter()
        for sc, t in ranked:
            if sc <= 0 or len(out) >= k - 3:
                break
            if per[t["ep"]] >= 2:
                continue
            per[t["ep"]] += 1
            out.append(t)
        # the analysis's own ties: the same big idea, in another episode
        sib = [t for i in self.ideas.get(s.get("item") or "", ()) for t in self.by_idea[i] if t["ep"] != s["ep"] and t not in out]
        sib.sort(key=lambda t: -self.score(q, self.spots.index(t)))
        for t in sib[:3]:
            out.append(t)
        return out[:k]


def ask(client, prompt):
    for wait in [300, 600, 1200, 1800, 1800, 1800, None]:   # the subscription's rate limit is waited out
        try:
            m = client.messages.create(model=MODEL, max_tokens=16000, messages=[{"role": "user", "content": prompt}])
            text = "".join(b.text for b in m.content if b.type == "text")
            return json.loads(text[text.index("{"):text.rindex("}") + 1]), m.usage
        except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError):
            if wait is None:
                raise
            print(json.dumps({"waiting": wait}), flush=True)
            time.sleep(wait)


def edition(client, P, n):
    mine = [s for s in P.spots if s["ep"] == n]
    blocks, cands = [], {}
    for s in mine:
        cs = P.candidates(s)
        cands[s["a"]] = {t["id"] for t in cs}
        head = f"[{s['a']}] ({s['kind']}, page {s['page']}) {s['head']}" + (f" — {s['kicker']}" if s["kicker"] else "")
        lines = [head, "  " + trim(s["text"], 170), "  Might take up the same thing:"]
        for t in cs:
            lines.append(f"  - {t['id']} (No. {t['ep']}, page {t['page']}, {t['kind']}) {t['head']}: {trim(t['lede'], 45)}"
                         + (f" [remembered as: {'; '.join(t['hooks'][:3])}]" if t["hooks"] else ""))
        blocks.append("\n".join(lines))
    t0 = time.time()
    for attempt in (1, 2):
        try:
            reply, usage = ask(client, BRIEF.format(n=n, pieces="\n\n".join(blocks)))
            break
        except ValueError:
            if attempt == 2:
                raise
    here = {s["a"]: s for s in mine}
    kept, dropped = [], collections.Counter()
    for r in reply.get("refs", []):
        s = here.get(r.get("a"))
        if not s or r.get("to") not in cands[s["a"]]:
            dropped["not offered"] += 1
            continue
        phrase = clean(r.get("phrase") or "")
        if not phrase or norm(phrase) not in norm(s["text"]):
            dropped["phrase not in the piece"] += 1
            continue
        if sum(1 for k in kept if k["a"] == s["a"]) >= 2 or any(k["a"] == s["a"] and k["to"] == r["to"] for k in kept):
            dropped["more than two"] += 1
            continue
        kept.append({"a": s["a"], "to": r["to"], "phrase": phrase, "label": clean(r.get("label") or "")[:60]})
    os.makedirs(OUT, exist_ok=True)
    tmp = os.path.join(OUT, f"{n:03d}.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False, indent=0)
        f.write("\n")
    os.replace(tmp, os.path.join(OUT, f"{n:03d}.json"))
    return {"edition": n, "pieces": len(mine), "refs": len(kept), "dropped": dict(dropped), "seconds": round(time.time() - t0), "out": usage.output_tokens}


def main(args):
    P = Prose()
    ns = [int(a) for a in args if a.isdigit()] or ([n for n in range(1, 129) if not os.path.exists(os.path.join(OUT, f"{n:03d}.json"))] if "--all" in args else [])
    with open(os.path.join(ROOT, "work", ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=3, timeout=900)
    for n in ns:
        try:
            print(json.dumps(edition(client, P, n)), flush=True)
        except Exception as e:   # one edition's trouble shouldn't stop the run
            print(json.dumps({"edition": n, "error": f"{type(e).__name__}: {str(e)[:200]}"}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
