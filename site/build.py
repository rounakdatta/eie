#!/usr/bin/env python3
"""Build what the site reads from the archive.

  python3 site/build.py 45   # site/data/045.json for the episode, and site/data/archive.json

Every moment is found in the transcript by its words, never by a stored time: a quote, the phrase a
recommendation or joke was said in (site/anchors.json, else its title, creator or quoted words), or
the first and last words of a story. Clips widen to whole sentences, so nothing starts mid-word.
"""
import difflib
import glob
import json
import os
import re
import sys

SITE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SITE), "data")
KINDS = {"S": "stories", "R": "recommendations", "C": "core_ideas", "J": "jokes_and_cultural_references"}
SPEAKERS = ["Amit Varma", "Ajay Shah", "other"]
ENDS = (".", "?", "!")


def load(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return json.load(f)


def tokens(text):
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split()


def cs(t):
    return round(t * 100)


class Transcript:
    """One episode's words, searchable by phrase."""

    def __init__(self, n):
        t = load(DATA, "original", "transcripts", f"{n:03d}.json")
        self.segments = t["segments"]
        self.words = [(w["startTime"], w["endTime"], w["word"], SPEAKERS.index(s["speaker"]))
                      for s in self.segments for w in s["words"]]
        self.toks, self.owner = [], []
        for i, w in enumerate(self.words):
            for tok in tokens(w[2]):
                self.toks.append(tok)
                self.owner.append(i)
        self.tri = {}
        for i in range(len(self.toks) - 2):
            self.tri.setdefault(tuple(self.toks[i:i + 3]), []).append(i)

    def locate(self, phrase):
        """(first, last) word of the phrase's best match at 75% or better; the earliest wins a tie."""
        q = tokens(phrase or "")
        if len(q) < 3:
            return None
        starts = {}
        for i in range(len(q) - 2):
            for j in self.tri.get(tuple(q[i:i + 3]), []):
                starts[j - i] = starts.get(j - i, 0) + 1
        best = None
        for s, _ in sorted(starts.items(), key=lambda kv: (-kv[1], kv[0]))[:8]:
            s = max(0, s)
            r = difflib.SequenceMatcher(None, q, self.toks[s:s + len(q)], autojunk=False).ratio()
            if best is None or r > best[0]:
                best = (r, s)
        if best is None or best[0] < 0.75:
            return None
        return self.owner[best[1]], self.owner[min(best[1] + len(q), len(self.toks)) - 1]

    def first_word(self, word):
        word = word.lower()
        return next((self.owner[i] for i, t in enumerate(self.toks) if t == word), None)

    def sentences(self, first, last, back=12.0, ahead=5.0, least=6.0):
        """Widen first..last to whole sentences, or to a 1.5 s lead-in when no sentence starts nearby.
        A clip shorter than `least` seconds takes in the sentence before it too: four seconds of
        "and Stossel calls this the double thank you moment" is too little to know what it's about."""
        i = first
        while i > 0 and not self.words[i - 1][2].endswith(ENDS) and self.words[first][0] - self.words[i - 1][0] <= back:
            i -= 1
        if i > 0 and not self.words[i - 1][2].endswith(ENDS):
            i = first
            while i > 0 and self.words[first][0] - self.words[i - 1][0] <= 1.5:
                i -= 1
        j = last
        while (j < len(self.words) - 1 and not self.words[j][2].endswith(ENDS)
               and self.words[j + 1][0] - self.words[last][1] <= ahead):
            j += 1
        if self.words[j][1] - self.words[i][0] < least and i > 0:
            k = i - 1
            while k > 0 and not self.words[k - 1][2].endswith(ENDS) and self.words[i][0] - self.words[k - 1][0] <= back:
                k -= 1
            if k == 0 or self.words[k - 1][2].endswith(ENDS):
                i = k
        return i, j

    def moment(self, first, last, words=False):
        """Times of the matched words, the whole-sentence clip around them, and who is speaking."""
        a, b = self.sentences(first, last)
        # Word timings abut (98.6% of gaps are zero) and a sentence's last word holds the pause after
        # it (0.50 s median against 0.24 s for any word), so the clip ends exactly there: any tail
        # played the next sentence's first word, "...better off. It's an incentive".
        m = {"at": [cs(self.words[first][0]), cs(self.words[last][1])],
             "clip": [cs(max(0, self.words[a][0] - 0.05)), cs(self.words[b][1])],
             "spk": self.words[first][3]}
        if words:  # karaoke for an episode the page doesn't load whole
            m["words"] = [[cs(w[0]), w[2], w[3]] for w in self.words[a:b + 1]]
        return m

    def turns(self):
        """Who holds the floor, as [start, end, speaker] in centiseconds."""
        out = []
        for s in self.segments:
            k = SPEAKERS.index(s["speaker"])
            if out and out[-1][2] == k and s["startTime"] - out[-1][1] / 100 < 1.5:
                out[-1][1] = cs(s["endTime"])
            else:
                out.append([cs(s["startTime"]), cs(s["endTime"]), k])
        return out

    def share(self):
        talk = [0.0, 0.0, 0.0]
        for w in self.words:
            talk[w[3]] += w[1] - w[0]
        return [round(x / sum(talk), 3) for x in talk]


_transcripts = {}


def transcript(n):
    if n not in _transcripts:
        _transcripts[n] = Transcript(n)
    return _transcripts[n]


def insights(n):
    return load(DATA, "generated", "insights", f"{n:03d}.json")


def insight(iid):
    ep = insights(int(iid[:3]))
    return ep[KINDS[iid[4]]][int(iid[5:]) - 1]


def title_of(item):
    return item.get("topic") or item.get("concept") or item.get("item") or item.get("content", "")[:80]


def quoted(text):
    """The words a joke or reference quotes, in reading order: the first is its setup. A quote mark
    opens only after a space or bracket and closes only before one, so "don't" stays whole."""
    frags = re.findall(r"(?:^|(?<=[\s(:—-]))[‘'\"“](.+?)[’'\"”](?=[\s.,;:)!?—-]|$)", text)
    return [f for f in frags if len(f) >= 12]


def anchor(n, iid, item, anchors):
    """Where in episode n an insight was said, as word indices, or None."""
    t = transcript(n)
    kind = iid[4]
    if iid in anchors["phrases"]:
        phrase = anchors["phrases"][iid]
        return t.locate(phrase) if phrase else None
    if kind in "SC":
        return t.locate(item.get("quote"))
    if kind == "J":
        for frag in quoted(item["content"]):
            hit = t.locate(frag)
            if hit:
                return hit
        return None
    hit = t.locate(re.sub(r"\(.*?\)", "", item["item"]))
    if hit:
        return hit
    surname = tokens(item.get("creator", ""))[-1:]
    if surname and surname[0] not in ("varma", "shah", "others") and len(surname[0]) > 3:
        i = t.first_word(surname[0])
        if i is not None:
            return i, i
    return None


def moment_of(iid, anchors, words=False):
    n = int(iid[:3])
    item = insight(iid)
    hit = anchor(n, iid, item, anchors)
    m = {"id": iid, "ep": n, "title": title_of(item)}
    if item.get("quote"):
        m["quote"] = item["quote"]
    if hit:
        m.update(transcript(n).moment(*hit, words=words))
    return m


def show_notes(n):
    """The description: its opening line, its 'In this episode' paragraph, and its numbered links."""
    with open(os.path.join(DATA, "original", "descriptions", f"{n:03d}.txt"), encoding="utf-8") as f:
        text = f.read()
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    about = next((p for p in paras if p.lower().startswith("in this episode")), "")
    links = re.findall(r"^\s*\d+\.\s*(.+?):?\s*(https?://\S+)\s*$", text, re.M)
    return {"tagline": paras[0] if paras else "", "about": about, "links": links}


def link_for(rec, links):
    """The show notes' link for a recommendation: the label's title part ("Title -- Creator", "Title —
    Creator: …") against the item's title, so a short title isn't swamped by the label's other words."""
    key = " ".join(tokens(re.sub(r"\(.*?\)", "", rec["item"])))

    def score(label):
        # a title may hold its own colon ("The Fatal Conceit: The Errors of Socialism"), so try both cuts
        cuts = (re.split(r"\s+(?:--|—|–)\s+", label)[0], re.split(r"\s+(?:--|—|–)\s+|:\s", label)[0])
        titles = [" ".join(tokens(c)) for c in cuts]
        return max(1.0 if t == key else difflib.SequenceMatcher(None, key, t).ratio() for t in titles)

    best = max(links, key=lambda l: score(l[0]), default=None)
    return best[1] if best and score(best[0]) >= 0.75 else None


def chapter_of(t, chapters):
    """Index of the chapter playing at t centiseconds."""
    return max((i for i, c in enumerate(chapters) if c["start"] * 100 <= t), default=0)


def build_episode(n, anchors, meta_all, works_by_mention, ideas_by_source, threads):
    ep = insights(n)
    meta = load(DATA, "original", "metadata", f"{n:03d}.json")
    t = transcript(n)
    notes = show_notes(n)
    index = meta_all[n]
    chapters = meta["chapters"]
    items = []
    for k, field in KINDS.items():
        for i, item in enumerate(ep[field], 1):
            iid = f"{n:03d}-{k}{i:02d}"
            row = {"id": iid, **item}
            hit = anchor(n, iid, item, anchors)
            if hit:
                row.update(t.moment(*hit))
                row["chapter"] = chapter_of(row["at"][0], chapters)
            if iid in anchors["spans"]:
                a, b = (t.locate(p) for p in anchors["spans"][iid])
                first, last = t.sentences(a[0], b[1])
                row["span"] = [cs(t.words[first][0] - 0.05), cs(t.words[last][1])]
            if iid in ideas_by_source:
                row["big"] = ideas_by_source[iid]
            if k == "R":
                work = works_by_mention[iid]
                row["work"] = work["id"]
                row["url"] = link_for(item, notes["links"])
                linked = re.search(r"Episode (\d+) of Everything is Everything", item["item"])
                if linked:
                    row["ep"] = int(linked.group(1))
            items.append(row)
    words = t.words
    return {
        "episode": {
            "n": n, "title": ep["episode_title"], "date": meta["release_date"], "videoId": meta["video_id"],
            "seconds": meta["duration_seconds"], "views": meta["view_count"], "likes": meta["like_count"],
            "comments": meta["comment_count"], "fetched": meta["fetched"], "chapters": chapters,
            "tagline": notes["tagline"], "about": notes["about"],
            "linksTo": index["links_to"], "linkedFrom": index["linked_from"], "threads": index["threads"],
        },
        "share": t.share(),
        "turns": t.turns(),
        # Karaoke for the whole episode: start times as centisecond deltas, words, and who said each.
        "words": {"t": [cs(w[0]) - (cs(words[i - 1][0]) if i else 0) for i, w in enumerate(words)],
                  "w": [w[2] for w in words], "s": [w[3] for w in words]},
        "items": items,
        "threads": [th for th in threads if any(s["episode"] == n for s in th["path"])],
    }


def main(n):
    anchors = load(SITE, "anchors.json")
    episodes = load(DATA, "generated", "episodes.json")["episodes"]
    meta_all = {e["episode_number"]: e for e in episodes}
    titles = {e["episode_number"]: e["title"] for e in episodes}
    big = load(DATA, "generated", "analysis", "big_ideas.json")["ideas"]
    works = load(DATA, "generated", "analysis", "reading_list.json")["items"]
    threads = load(DATA, "generated", "analysis", "threads.json")
    works_by_mention = {m: w for w in works for m in w["mentions"]}
    ideas_by_source = {}
    for idea in big:
        for s in idea["sources"] + [idea["quote"]["source"]]:
            ideas_by_source.setdefault(s, [])
            if idea["id"] not in ideas_by_source[s]:
                ideas_by_source[s].append(idea["id"])

    out = build_episode(n, anchors, meta_all, works_by_mention, ideas_by_source, threads["threads"])
    mine = {i["id"] for i in out["items"]}
    # The big ideas this episode feeds, with every moment behind them, from whichever episode.
    out["bigIdeas"] = []
    for idea in big:
        if not mine & set(idea["sources"] + [idea["quote"]["source"]]):
            continue
        out["bigIdeas"].append({
            "id": idea["id"], "name": idea["name"], "summary": idea["summary"], "why": idea["why_it_matters"],
            "thinkers": idea["thinkers"], "episodes": idea["episodes"],
            "quote": {"text": idea["quote"]["text"], **moment_of(idea["quote"]["source"], anchors, words=True)},
            "sources": [moment_of(s, anchors, words=int(s[:3]) != n) for s in idea["sources"]],
        })
    rec_works = {i["work"] for i in out["items"] if "work" in i}
    # Every other time a work came up, as a moment to hear where its mention can be found.
    out["works"] = {w["id"]: {"title": w["title"], "creator": w.get("creator", ""), "type": w["type"],
                              "byHosts": w["by_hosts"], "recommenders": w["recommenders"],
                              "episodes": w["episodes"], "why": w["why"],
                              "mentions": [moment_of(m, anchors, words=True) for m in w["mentions"] if int(m[:3]) != n]}
                    for w in works if w["id"] in rec_works}
    out["titles"] = titles
    # The plates, inline so the page can theme them; drawn by hand for each episode in site/art/NNN.
    out["art"] = {}
    for path in sorted(glob.glob(os.path.join(SITE, "art", f"{n:03d}", "*.svg"))):
        name = os.path.basename(path)[:-4]
        with open(path, encoding="utf-8") as f:
            out["art"][name if name == "cover" else f"{n:03d}-{name}"] = f.read().strip()
    with open(os.path.join(SITE, "data", f"{n:03d}.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    # The whole show, for the ribbon: each episode with one moment worth hearing.
    archive = []
    for e in episodes:
        m = e["episode_number"]
        tr = transcript(m)
        cores = [f"{m:03d}-C{i:02d}" for i in range(1, e["counts"]["core_ideas"] + 1)]
        cores = [c for c in cores if insight(c).get("quote")]
        pick = max(cores, key=lambda c: (len(ideas_by_source.get(c, [])), -int(c[5:])))
        seconds = load(DATA, "original", "metadata", f"{m:03d}.json")["duration_seconds"]
        archive.append({"n": m, "title": e["title"], "date": e["release_date"], "seconds": seconds,
                        "videoId": e["url"].split("=")[-1], "views": e["view_count"], "share": tr.share(),
                        "threads": e["threads"], "moment": moment_of(pick, anchors, words=True)})
        _transcripts.pop(m, None) if m != n else None
    with open(os.path.join(SITE, "data", "archive.json"), "w", encoding="utf-8") as f:
        json.dump({"episodes": archive, "startHere": threads["start_here"],
                   "threads": [{"id": th["id"], "name": th["name"]} for th in threads["threads"]]},
                  f, ensure_ascii=False, separators=(",", ":"))
    missing = [i["id"] for i in out["items"] if "at" not in i]
    print(f"episode {n}: {len(out['items'])} items, {len(missing)} without a moment {missing}; "
          f"{len(out['bigIdeas'])} big ideas, {len(out['works'])} works", file=sys.stderr)


if __name__ == "__main__":
    main(int(sys.argv[1]))
