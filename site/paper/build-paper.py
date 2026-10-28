#!/usr/bin/env python3
"""Build the newspaper: every edition that has its copy, the shared paper.js, and the list of editions.

  python3 site/paper/build-paper.py          # every site/editions/NNN with copy.json and media.json
  python3 site/paper/build-paper.py 45 46    # just these (the list of editions is always rebuilt)

Needs pyphen (pip install pyphen). For each edition it writes, into site/editions/NNN/:

  edition.json  the copy made ready to set: its pictures from media.json, its moments found in the
                transcript by their phrases, the shelf and the laugh lines drawn from the archive, the
                crossword laid out, and soft hyphens put into running text so justified columns stay
                even in every browser (Chrome has no hyphenation dictionary on Linux or Windows).
  data.json     what the page needs of the episode: its words and who said them, the turns, the
                insights' moments.
  index.html    the page, with the edition's own title, description and preview picture.

and site/editions/index.json, every edition in brief, for the archive page and the edition bar.

paper.js is paper-src.js with the helpers and the moment player spliced in from ../app.js, so the
illustrated page and the newspaper share one player and one set of fixes.
"""
import html
import json
import os
import re
import sys

import pyphen

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
EDITIONS = os.path.join(SITE, "editions")
DATA = os.path.join(os.path.dirname(SITE), "data")
PUBLIC = "https://eie.taptappers.club"
sys.path.insert(0, SITE)
import build  # noqa: E402  the site's transcript tools: phrase search, sentence-wide clips
sys.path.insert(0, HERE)
import crossword  # noqa: E402
import copydesk  # noqa: E402

HY = pyphen.Pyphen(lang="en_US", left=2, right=3)
WORD = re.compile(r"(?<![\w’'-])[a-z]{6,}(?![\w’'])")   # lower-case words of six letters or more; names stay whole
TOKEN = re.compile(r"(\{[^}]*\}|\*[^*]*\*)")           # moment marks and *titles* are set as they are
RUNNING = {"body", "text", "why", "postscript", "def", "a", "boxText"}   # fields set as justified running text

# A picture's crop, as heights for its width: the least, the natural and the most the engine may give it.
RATIO = {"lead": [0.42, 0.5625, 0.8], "second": [0.5, 0.5625, 1.5], "third": [0.6, 0.75, 1.9],
         "story": [0.4, 0.5625, 0.9], "section": [0.42, 0.5625, 0.74], "side": [0.9, 1.25, 1.7]}
FIRST = {"Amit Varma": "Amit", "Ajay Shah": "Ajay"}


def load(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return json.load(f)


def hyphenate(text):
    return "".join(part if TOKEN.fullmatch(part) else WORD.sub(lambda m: HY.inserted(m.group(0), hyphen="­"), part)
                   for part in TOKEN.split(text))


def smart(s):
    """Typewriter quotes to typographer's: an opening one after a space or bracket, else closing."""
    s = re.sub(r'(^|[\s(\[—-])"', "\\1“", s).replace('"', "”")
    s = re.sub(r"(^|[\s(\[—-])'", "\\1‘", s).replace("'", "’")
    return s


def smarten(obj, keys, on=False):
    """smart() on the text under these keys, at any depth: a string, or the strings in a list, under one
    of them. A dict under one is looked into key by key (a section may be called "credit")."""
    if isinstance(obj, dict):
        return {k: smarten(v, keys, k in keys) for k, v in obj.items()}
    if isinstance(obj, list):
        return [smarten(v, keys, on) for v in obj]
    return smart(obj) if on and isinstance(obj, str) else obj


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
                run += cells[(rr, cc)]
                rr += dr
                cc += dc
            if len(run) > 1 and (run, r, c, d) not in answers:
                raise ValueError(f"crossword: stray word {run!r} at {r},{c} {d}")


class Archive:
    """The archive's shared parts, loaded once for every edition."""

    def __init__(self):
        self.anchors = load(SITE, "anchors.json")
        self.episodes = {e["episode_number"]: e for e in load(DATA, "generated", "episodes.json")["episodes"]}
        big = load(DATA, "generated", "analysis", "big_ideas.json")["ideas"]
        self.works = load(DATA, "generated", "analysis", "reading_list.json")["items"]
        self.threads = load(DATA, "generated", "analysis", "threads.json")
        self.works_by_mention = {m: w for w in self.works for m in w["mentions"]}
        self.ideas_by_source = {}
        for idea in big:
            for s in idea["sources"] + [idea["quote"]["source"]]:
                self.ideas_by_source.setdefault(s, [])
                if idea["id"] not in self.ideas_by_source[s]:
                    self.ideas_by_source[s].append(idea["id"])

    def episode(self, n):
        return build.build_episode(n, self.anchors, self.episodes, self.works_by_mention, self.ideas_by_source,
                                   self.threads["threads"])


KEEP = ("id", "at", "clip", "spk", "chapter", "teller", "concept", "topic", "item", "content", "span")


def slim(ep):
    """What the page reads of an episode: no explanations, no other episodes, no plates."""
    items = []
    for it in ep["items"]:
        row = {k: it[k] for k in KEEP if k in it}
        if "content" in row and len(row["content"]) > 140:
            row["content"] = row["content"][:137].rsplit(" ", 1)[0] + "…"
        items.append(row)
    return {"episode": ep["episode"], "share": ep["share"], "turns": ep["turns"], "words": ep["words"], "items": items}


def page_of(target, copy):
    """Which page an anchor in the copy is on, for the skyline's and the footnote's pointers."""
    if target in ("lead", "second", "third", "brief") or target == "p1":
        return "P1"
    if target == "p2" or any(s["id"] == target for s in copy["p2"]["sections"]) or target == "from1":
        return "P2"
    if target in ("p3", "numbers") or any(s["id"] == target for s in copy["p3"]["stories"]):
        return "P3"
    return "P4"


def credits(n, media, notes):
    """The colophon: what the edition is made from, and whose pictures it uses."""
    if isinstance(media.get("credits"), str):
        return media["credits"]
    art = re.search(r"^(Chapter image[^:\n]*?) by Simahina", notes, re.M | re.I)
    parts = [
        "Everything is Everything was Amit Varma and Ajay Shah’s weekly show, 128 episodes from June 2023 to December 2025. "
        f"This edition is made from Episode {n}.",
        "The moving pictures, stills and chapter cards are from its video" + ("; the chapter art is by Simahina." if art else "."),
        "Every play button starts the video at the moment it was said.",
        "The articles and headlines were written by Claude, an AI model, from the episode’s machine-made transcript, and checked against it.",
    ]
    photos = media.get("credits") or []
    if photos:
        parts.append("Other photographs are from Wikimedia Commons: " + "; ".join(photos) + ".")
    return " ".join(parts)


def picture(m, slot, **extra):
    """A picture for the page from its manifest entry: the crop it may take, and how it plays."""
    if not m:
        return None
    pic = {k: v for k, v in m.items() if k in ("src", "video", "poster", "caption", "credit", "focus", "ratio", "card")}
    pic.setdefault("ratio", RATIO[slot])
    return {**pic, **extra}


def build_edition(n, archive, editions):
    d = os.path.join(EDITIONS, f"{n:03d}")
    copy = load(d, "copy.json")
    media = smarten(load(d, "media.json"), {"caption", "credit", "credits", "who"})   # Commons writes typewriter quotes
    ep = archive.episode(n)
    data = slim(ep)
    items = {i["id"]: i for i in ep["items"]}
    t = build.transcript(n)
    notes = open(os.path.join(DATA, "original", "descriptions", f"{n:03d}.txt"), encoding="utf-8").read()

    # moments named by a phrase, for things the episode states in passing
    moments = {}
    for m in copy["moments"]:
        hit = t.locate(m["phrase"])
        if not hit:
            raise ValueError(f"moment {m['name']!r}: phrase not found in the transcript")
        moments[m["name"]] = {**t.moment(*hit), "title": m["phrase"]}
    # a story's whole telling, from its first words to its last
    spans = {}
    for s in copy["p3"]["stories"]:
        a, b = t.locate(s["start"]), t.locate(s["end"])
        if not a or not b or b[1] <= a[0]:
            raise ValueError(f"story {s['id']!r}: its start or end was not found in order")
        first, last = t.sentences(a[0], b[1])
        spans[s["item"]] = [build.cs(t.words[first][0] - 0.05), build.cs(t.words[last][1])]

    # the shelf: every recommendation, with the reason the reading list gives for works that recur
    shelf = []
    for it in (i for i in ep["items"] if i["id"][4] == "R"):
        work = archive.works_by_mention.get(it["id"], {})
        recurring = len(work.get("episodes", [])) > 1
        why = (work["why"] if recurring else it["reason"])
        why = smart(re.split(r"(?<=[.!?])\s+(?=[A-Z“'\"])", why)[0])
        title = smart(re.sub(r"\s*\(Episode (\d+) of Everything is Everything\)", r" (Episode \1)", it["item"]))
        shelf.append({"id": it["id"], "title": title, "creator": smart(it.get("creator", "")), "type": it["type"],
                      "why": why, "episodes": len(work.get("episodes", [])) or 1, "url": it.get("url"),
                      "who": it["recommender"]})
    L = copy["laughs"]
    laughs = [{"id": i, "type": items[i]["type"], "text": smart(items[i]["content"])} for i in L["funny"] + L["refs"]]

    # the crossword: laid out once, numbered, every answer an entry in the episode
    cw = copy["crossword"]
    layout = crossword.build([(w["answer"],) for w in cw["words"]], seed=cw.get("seed", 1), tries=1200,
                             max_w=cw.get("maxW", 15), max_h=cw.get("maxH", 13), required=tuple(cw["required"]))
    if layout is None:
        raise ValueError("crossword: no layout holds every required word")
    check_grid(layout)
    clues = {w["answer"]: w for w in cw["words"]}
    entries = [{**e, **{k: clues[e["answer"]][k] for k in ("clue", "enum", "ref")}} for e in crossword.number(layout)]

    M, P1, P2, P3 = media, copy["lead"], copy["p2"], copy["p3"]
    sky = []
    for k, s in enumerate(copy["skyline"]):
        row = {**s, "page": page_of(s["to"], copy)}
        if k == 0:
            row.update(cutout="amit-cut.webp", who="Amit Varma")
        elif k == 1:
            row.update(cutout="ajay-cut.webp", who="Ajay Shah")
        else:
            row["photo"] = M.get("skyline")
        sky.append(row)
    lead_pic = picture(M.get("lead"), "lead", play={"reel": P1["reel"], "label": P1["reelLabel"]})
    second, third = copy["second"], copy["third"]
    whole = lambda i: "whole" if i in spans or items.get(i, {}).get("span") else "line"
    E = {
        "episode": n,
        "moments": moments,
        "spans": spans,
        "masthead": {
            "skyline": sky,
            "folio": {"left": f"Episode {n} · 4 pages", "price": "₹0.00*", "right": "youtube.com/@amitvarma"},
            "footnote": f"*{copy['footnote']['text']} {page_of(copy['footnote']['to'], copy).replace('P', 'Page ')}",
        },
        "index": [{"label": P2["title"], "page": "P2", "to": "p2"}, {"label": P3["title"], "page": "P3", "to": "p3"},
                  {"label": "By the numbers", "page": "P3", "to": "numbers"}, {"label": copy["shelf"]["title"], "page": "P4", "to": "shelf"},
                  {"label": L["title"], "page": "P4", "to": "laughs"}, {"label": "Quiz", "page": "P4", "to": "quiz"}],
        "p1": {
            "brief": copy["brief"],
            "thought": {"label": "Thought for the day", **copy["thought"]},
            "lead": {"kicker": P1["kicker"], "head": P1["head"], "byline": "The transcript desk", "pic": lead_pic, "cols": 2,
                     "dateline": f"Episode {n}", "body": P1["body"], "cut": "from1", "reel": P1["reel"],
                     "reelUnit": P1["reelUnit"], "reelName": P1["reelName"]},
            "second": {"id": "second", "label": second["label"], "head": second["head"], "deck": second["deck"],
                       "pic": picture(M.get("second"), "second", **({} if (M.get("second") or {}).get("src") else {"play": {"item": second["item"], "mode": "line"}})),
                       "body": second["body"], "quote": second["quote"], "listen": [{"item": second["item"], "mode": whole(second["item"])}]},
            "third": {"id": "third", "head": third["head"], "pic": picture(M.get("third"), "third", play={"item": third["item"], "mode": "line"}),
                      "body": third["body"], "listen": [{"item": third["item"], "mode": whole(third["item"])}]},
        },
        "p2": {
            "title": P2["title"], "deck": P2["deck"], "from1": {"head": P1["head"]},
            "side": {"quote": P2["sections"][0]["quote"], "photo": picture(M.get("side"), "side"),
                     "box": {"title": P2["side"]["boxTitle"], "text": P2["side"]["boxText"]}},
            "sections": [{**{k: v for k, v in s.items() if k != "portraits"},
                          "art": picture((M.get("sections") or {}).get(s["id"]), "section"),
                          "portraits": M.get("portraits", {}).get(s["id"]) or None} for s in P2["sections"]],
            "cont": {"quote": P2["contQuote"]},
        },
        "p3": {
            "title": P3["title"], "deck": P3["deck"],
            "stories": [{**{k: v for k, v in s.items() if k not in ("start", "end", "caption")},
                         "pic": picture((M.get("stories") or {}).get(s["id"]), "story", play={"item": s["item"], "mode": "whole"})} for s in P3["stories"]],
            "numbers": P3["numbers"],
        },
        "p4": {
            "shelf": {"title": copy["shelf"]["title"], "deck": f"All {len(shelf)} things the hosts recommended, and why",
                      "portraits": M.get("shelf") or None,
                      "wide": copydesk.shelf_wide(len(shelf), sum(1 for i in ep["items"] if i["id"][4] == "J"))},
            "laughs": {"title": L["title"], "refsTitle": L["refsTitle"], "overheard": L["overheard"]},
            "quiz": copy["quiz"],
            "glossary": copy["glossary"],
            "credits": credits(n, media, notes),
        },
        "shelf": shelf,
        "laughs": laughs,
        "crossword": {"w": layout["w"], "h": layout["h"], "entries": entries},
        "chapters": {c["title"]: c["short"] for c in copy["chapters"]},
    }
    unmark = lambda s: re.sub(r"\s*\{[^}]*\}", "", s)   # the paper adds the item's own mark here
    E["p1"]["thought"]["who"] = unmark(E["p1"]["thought"]["who"])
    for q in E["p4"]["quiz"]:
        q["a"] = unmark(q["a"])
    for g in E["p4"]["glossary"]:
        g["def"] = unmark(g["def"])
    E = walk(E)

    # the edition's neighbours, for the edition bar and the foot of the last page
    order = sorted(editions)
    i = order.index(n)
    near = lambda k: {"n": order[k], "head": editions[order[k]]["head"]} if 0 <= k < len(order) else None
    E["nav"] = {"prev": near(i - 1), "next": near(i + 1), "total": len(order)}

    with open(os.path.join(d, "edition.json"), "w", encoding="utf-8") as f:
        json.dump(E, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(d, "data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    page(n, d, editions[n])
    return f"{n:03d}: {len(moments)} moments, {len(spans)} spans, {len(shelf)} on the shelf, {len(laughs)} laughs, crossword {len(entries)}/{len(cw['words'])}"


def page(n, d, ed):
    """index.html from the template, with this edition's title, description and preview picture."""
    tpl = open(os.path.join(HERE, "edition.html"), encoding="utf-8").read()
    head = ed["head"]
    desc = f"Episode {n} of Everything is Everything as a newspaper: {ed['deck']}"
    image = f"{PUBLIC}/{n}/media/{ed['poster']}" if ed.get("poster") else ""
    out = (tpl.replace("{{N}}", str(n)).replace("{{TITLE}}", html.escape(f"{head} · Everything is Everything, Episode {n}"))
           .replace("{{HEAD}}", html.escape(head)).replace("{{DESC}}", html.escape(desc))
           .replace("{{IMAGE}}", html.escape(image)).replace("{{URL}}", f"{PUBLIC}/{n}/"))
    with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as f:
        f.write(out)


def summary(n):
    """One edition in brief, from its copy and pictures, for the list of editions."""
    d = os.path.join(EDITIONS, f"{n:03d}")
    copy, media = load(d, "copy.json"), load(d, "media.json")
    e = load(DATA, "generated", "episodes.json")["episodes"][n - 1]
    assert e["episode_number"] == n
    return {"n": n, "date": e["release_date"], "title": smart(e["title"]), "minutes": e["duration_minutes"],
            "head": copy["lead"]["head"], "deck": copy["lead"]["kicker"],
            "poster": (media.get("lead") or {}).get("poster"), "threads": e.get("threads", []),
            "thumb": "thumb.jpg" if os.path.exists(os.path.join(d, "media", "thumb.jpg")) else None,
            "sections": [s["head"] for s in copy["p2"]["sections"]], "stories": [s["head"] for s in copy["p3"]["stories"]]}


def paper_js():
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
    return len(out)


def main(args):
    ready = sorted(int(x) for x in os.listdir(EDITIONS)
                   if x.isdigit() and all(os.path.exists(os.path.join(EDITIONS, x, f)) for f in ("copy.json", "media.json")))
    editions = {n: summary(n) for n in ready}
    threads = load(DATA, "generated", "analysis", "threads.json")
    with open(os.path.join(EDITIONS, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"editions": [editions[n] for n in ready], "startHere": smarten(threads["start_here"], {"why"}),
                   "threads": [smarten({k: t[k] for k in ("id", "name", "summary", "path")}, {"name", "summary", "why"})
                               for t in threads["threads"]]},
                  f, ensure_ascii=False, separators=(",", ":"))
    todo = [int(a) for a in args] or ready
    archive = Archive()
    failed = []
    for n in todo:
        try:
            print(build_edition(n, archive, editions))
        except Exception as e:  # one bad edition shouldn't stop the rest
            failed.append(n)
            print(f"{n:03d}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
        build._transcripts.pop(n, None)   # tens of MB each: keep one in memory at a time
    print(f"paper.js {paper_js()} bytes; {len(todo) - len(failed)} of {len(todo)} editions built")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
