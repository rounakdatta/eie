#!/usr/bin/env python3
"""Make the newspaper's two generated files.

  python3 site/paper/build-paper.py      # needs pyphen (pip install pyphen)

edition-045.built.json is edition-045.json made ready to set: the episode's own words placed (custom
moments found in the transcript by their phrase), the shelf and the laugh lines drawn from the
episode data, and soft hyphens put into running text so justified columns stay even in every
browser (Chrome has no hyphenation dictionary on Linux or Windows).

paper.js is paper-src.js with the helpers and the moment player spliced in from ../app.js, so the
illustrated page and the newspaper share one player and one set of fixes.
"""
import json
import os
import re
import sys

import pyphen

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, SITE)
import build  # noqa: E402  the site's transcript tools: phrase search, sentence-wide clips
sys.path.insert(0, HERE)
import crossword  # noqa: E402

HY = pyphen.Pyphen(lang="en_US", left=2, right=3)
WORD = re.compile(r"(?<![\w’'-])[a-z]{6,}(?![\w’'])")   # lower-case words of six letters or more; names stay whole
TOKEN = re.compile(r"(\{[^}]*\}|\*[^*]*\*)")           # moment chips and *titles* are set as they are


def hyphenate(text):
    return "".join(part if TOKEN.fullmatch(part) else WORD.sub(lambda m: HY.inserted(m.group(0), hyphen="­"), part)
                   for part in TOKEN.split(text))


RUNNING = {"body", "text", "why", "postscript", "def", "a"}   # fields set as justified running text


def smart(s):
    """Typewriter quotes to typographer's: an opening one after a space or bracket, else closing."""
    s = re.sub(r'(^|[\s(\[—-])"', "\\1“", s).replace('"', "”")
    s = re.sub(r"(^|[\s(\[—-])'", "\\1‘", s).replace("'", "’")
    return s


def walk(obj, key=None):
    if isinstance(obj, dict):
        return {k: walk(v, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [walk(v, key) for v in obj]
    if isinstance(obj, str) and key in RUNNING:
        return hyphenate(obj)
    return obj


def check_grid(layout):
    """Every run of two or more letters in the grid, across and down, must be one of the answers."""
    cells = {}
    for word, r, c, d in layout["placed"]:
        for i, ch in enumerate(word):
            cells[(r, c + i) if d == "a" else (r + i, c)] = ch
    answers = {(w, r, c, d) for w, r, c, d in layout["placed"]}
    for d, (dr, dc) in (("a", (0, 1)), ("d", (1, 0))):
        for (r, c) in cells:
            if (r - dr, c - dc) in cells:
                continue
            run, rr, cc = "", r, c
            while (rr, cc) in cells:
                run += cells[(rr, cc)]; rr += dr; cc += dc
            if len(run) > 1 and (run, r, c, d) not in answers:
                sys.exit(f"crossword: stray word {run!r} at {r},{c} {d}")


def main():
    edition = json.load(open(os.path.join(HERE, "edition-045.json"), encoding="utf-8"))
    n = edition["episode"]
    data = json.load(open(os.path.join(SITE, "data", f"{n:03d}.json"), encoding="utf-8"))
    items = {i["id"]: i for i in data["items"]}
    t = build.transcript(n)

    # moments named by a phrase, for figures the episode states in passing
    moments = {}
    for key, phrase in edition["moments"].items():
        hit = t.locate(phrase)
        if not hit:
            sys.exit(f"moment {key!r}: phrase not found in the transcript")
        moments[key] = {**t.moment(*hit), "title": phrase}

    # the shelf: every recommendation, with the reason the reading list gives for works that recur
    shelf = []
    for it in (i for i in data["items"] if i["id"][4] == "R"):
        work = data["works"].get(it["work"], {})
        recurring = len(work.get("episodes", [])) > 1
        why = (work["why"] if recurring else it["reason"])
        why = smart(re.split(r"(?<=[.!?])\s+(?=[A-Z“'\"])", why)[0])
        title = smart(re.sub(r"\s*\(Episode (\d+) of Everything is Everything\)", r" (Episode \1)", it["item"]))
        shelf.append({"id": it["id"], "title": title, "creator": it.get("creator", ""), "type": it["type"],
                      "why": why, "episodes": len(work.get("episodes", [])) or 1, "url": it.get("url"),
                      "who": it["recommender"]})
    laughs = [{"id": i["id"], "type": i["type"], "text": smart(i["content"])} for i in data["items"] if i["id"][4] == "J"]

    # the crossword: laid out once, numbered, every answer an entry in the episode
    cw = edition["crossword"]
    layout = crossword.build([(w["answer"],) for w in cw["words"]], seed=cw["seed"], tries=1200,
                             max_w=cw["maxW"], max_h=cw["maxH"], required=tuple(cw["required"]))
    check_grid(layout)
    clues = {w["answer"]: w for w in cw["words"]}
    entries = [{**e, **{k: clues[e["answer"]][k] for k in ("clue", "enum", "ref")}} for e in crossword.number(layout)]
    edition["crossword"] = {"w": layout["w"], "h": layout["h"], "entries": entries}

    edition = walk({**edition, "moments": moments, "shelf": shelf, "laughs": laughs})
    with open(os.path.join(HERE, f"edition-{n:03d}.built.json"), "w", encoding="utf-8") as f:
        json.dump(edition, f, ensure_ascii=False, separators=(",", ":"))

    # paper.js
    app = open(os.path.join(SITE, "app.js"), encoding="utf-8").read()
    src = open(os.path.join(HERE, "paper-src.js"), encoding="utf-8").read()

    def between(start, end):
        a = app.index(start)
        return app[a:app.index(end, a)].rstrip() + "\n"

    helpers = between("const PLAY = ", "\nlet D, A;") + between("const store = {", "/* ── keep (bookmarks)")
    player = between("const Player = {", "/* ── the ribbon of 128 episodes")
    out = src.replace("//@include helpers\n", helpers).replace("//@include player\n", player)
    assert "//@include" not in out
    with open(os.path.join(HERE, "paper.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by build-paper.py from paper-src.js and ../app.js. Edit those, not this.\n" + out)
    print(f"edition-{n:03d}.built.json: {len(moments)} moments, {len(shelf)} shelf entries, {len(laughs)} laughs; paper.js {len(out)} bytes")


if __name__ == "__main__":
    main()
