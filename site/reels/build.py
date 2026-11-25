#!/usr/bin/env python3
"""The reel: every nugget that has its moment, made ready to play one after another.

  python3 site/reels/build.py        # writes site/search/reels.jsonl, which the desk serves at /api/reels

A nugget is one of the archive's insights (a story, an idea, a recommendation, a laugh) whose moment
build.py found in the transcript: the `clip` of site/editions/NNN/data.json, whole sentences on the
YouTube video's clock. Everything here is made from what is already computed; no model is called.

For each nugget:
  - what it is and who said it, the episode, the clip, the chapter;
  - its words as they are said, each with the time it starts, for the caption the reel inks as it plays:
    the transcript's words in the clip, with the fillers ("uh", "um") and stutters dropped, and set
    against the insight's own quote where it has one, so the caption has the quote's spelling (the
    transcript heard "Satanic Verses" as "satanic versus") with the transcript's times;
  - a headline, a line on why it matters, and the rest, from the insight;
  - where the paper prints it (spots.py) and a picture to show until the video's first frame: a frame
    of the same speaker from the edition's own pictures, or the edition's opening shot;
  - for a recommendation, the cover the shelf shows.

and the orders the reel can be watched in: the newsreel (the best first, then everything, mixed so
that no episode, kind or voice runs on), each episode in the order it was said, and each of the fifty
big ideas as the show developed it.
"""
import difflib
import glob
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
DATA = os.path.join(os.path.dirname(SITE), "data")
OUT = os.path.join(SITE, "search", "reels.jsonl")
sys.path.insert(0, os.path.join(SITE, "search"))
from spots import spots  # noqa: E402

KINDS = {"S": "stories", "R": "recommendations", "C": "core_ideas", "J": "jokes_and_cultural_references"}
FILLERS = {"uh", "um", "uhm", "umm", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm"}
# one- and two-letter tokens that are words; any other is a stutter's first sound ("y you know")
SHORT = set("a i o an as at be by do go he if in is it me my no of oh ok on or so to up us we ye".split())
LEAST = 3.0   # seconds: a clip shorter than this is too short to stand alone in the newsreel (it stays in its episode's)


def load(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return json.load(f)


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'").replace("‘", "'"))


def clean_said(words):
    """The clip's words as [(cs, word)], without fillers or a stutter's false starts."""
    out = []
    for k, (t, w) in enumerate(words):
        n = norm(w)
        if not n or n in FILLERS:
            continue
        nxt = norm(words[k + 1][1]) if k + 1 < len(words) else ""
        if len(n) <= 2 and n not in SHORT and nxt.startswith(n) and nxt != n:
            continue   # "y you", "th the"
        if out and norm(out[-1][1]) == n and n in {"the", "a", "i", "and", "to", "that", "it", "is", "we", "you", "so", "but", "of", "in", "this"}:
            continue   # "the the": shown once, lit when it was first said
        out.append((t, w))
    return out


def tokenize_text(text):
    """A quote's words as printed: punctuation kept on the word, curly quotes as typeset."""
    return [w for w in re.split(r"\s+", text.strip()) if w]


def edge(said_words, quote_words, tail):
    """How many said words, next to the quote's first or last match, stand for the quote's unmatched
    words at that end: the run that spells most like them ("stiffenbox" for "tiffin box"), or none."""
    if not quote_words or not said_words:
        return 0
    target, best = "".join(quote_words), (0.0, 0)
    for m in range(1, min(4, len(said_words)) + 1):
        run = said_words[:m] if tail else said_words[-m:]
        r = difflib.SequenceMatcher(None, "".join(run), target, autojunk=False).ratio()
        if r > best[0]:
            best = (r, m)
    return best[1] if best[0] >= 0.5 else 0


def align(said, quote):
    """The words to show. Where the quote was said (its span in the clip: from its first matching word
    to its last, and over the words next to them that spell like the quote's unmatched ends), the
    quote's own words, spelt as printed, at the times the transcript gives the words they stand for;
    before and after it, the words as the transcript heard them. Inside the span the quote is the
    authority: a word misheard ("Proctor Hawk" for "propter hoc") shows as the quote has it, and a
    filler the quote left out ("you know") is left out of the caption too. A caption shows only what
    is heard: a run of quote words with nothing said for them (more than two) is left out."""
    if not quote:
        return said
    q = [w for w in tokenize_text(quote) if norm(w) not in FILLERS]
    if not q:
        return said
    a, b = [norm(w) for _, w in said], [norm(w) for w in q]
    blocks = [x for x in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks() if x.size]
    if sum(x.size for x in blocks) < 0.6 * len(b):
        return said   # not this quote after all: show what was said
    f, l = blocks[0], blocks[-1]
    lo = f.a - edge(a[:f.a], b[:f.b], tail=False)
    hi = l.a + l.size + edge(a[l.a + l.size:], b[l.b + l.size:], tail=True)
    qlo = f.b if lo == f.a else 0
    qhi = l.b + l.size if hi == l.a + l.size else len(b)
    end = lambda i: said[i][0] if i < len(said) else said[-1][0] + 40
    if lo > 0 and said[lo - 1][1][-1:] not in ".?!" and q[0][:1].isupper() and q[0] != "I" and norm(q[0]) == a[lo] and said[lo][1][:1].islower():
        q[0] = q[0][:1].lower() + q[0][1:]
    out = list(said[:lo])
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a[lo:hi], b[qlo:qhi], autojunk=False).get_opcodes():
        i1, i2, j1, j2 = i1 + lo, i2 + lo, j1 + qlo, j2 + qlo
        if op == "equal" or (op == "replace" and i2 - i1 == j2 - j1):
            out += [(said[i1 + k][0], q[j1 + k]) for k in range(j2 - j1)]
        elif op == "replace" or (op == "insert" and j2 - j1 <= 2):
            # the quote's words across the time the said words took (an insert: at the next word's time)
            t0, t1 = end(i1), end(i2)
            lens = [max(1, len(w)) for w in q[j1:j2]]
            out += [(t0 + round((t1 - t0) * sum(lens[:k]) / sum(lens)), w) for k, w in enumerate(q[j1:j2])]
        # "delete": said, and left out of the quote
    out += said[hi:]
    return out


ENDINGS = {"s", "es", "n", "an", "ian", "ns", "ans", "ic", "ics", "ish", "ese", "ed", "ing", "ji", "er", "ers", "al", "ly", "y", "e"}


def form(a, b):
    """Is one of the two words the other with a common ending (India, Indian; German, Germans)?"""
    short, long = sorted((a, b), key=len)
    return long.startswith(short) and long[len(short):] in ENDINGS


PHRASES = [(["scene", "and", "the", "unseen"], ["Seen", "and", "the", "Unseen"]),
           (["everything", "is", "everything"], ["Everything", "is", "Everything"])]


def fix_names(words, texts):
    """Names the transcript misheard, put right from the nugget's own text: a capitalised word in the
    caption that is one letter or two from a name its insight spells ("Chinme" for Chinmay, "Montaine"
    for Montaigne, "Goha" for Guha), and the show's other podcast, heard as "the scene and the unseen"."""
    out = list(words)
    k = 0
    while k < len(out):   # the fixed phrases first
        for said, right in PHRASES:
            n = len(said)
            if [norm(w) for _, w in out[k:k + n]] == said:
                tail = re.sub(r"^[\w'’-]+", "", out[k + n - 1][1])
                out[k:k + n] = [(t, r + (tail if j == n - 1 else "")) for j, ((t, _), r) in enumerate(zip(out[k:k + n], right))]
        k += 1
    names = {}
    for text in texts:
        for w in re.findall(r"[A-Z][\w’'-]{2,}", text or ""):
            w = re.sub(r"[’']s$", "", w)
            names.setdefault(norm(w), w)
    for k, (t, w) in enumerate(out):
        m = re.match(r"^([\W]*)([A-Z][a-z]+)([\W]*)$", w)
        if not m:
            continue
        core = m.group(2).lower()
        if core in names or len(core) < 4:
            continue
        # a near miss, not another form of the same word: "Indian" is not a mishearing of "India", nor
        # "Germans" of "German", nor "Gandhiji" of "Gandhi" (one is the other and a common ending);
        # "Bastia" is "Bastiat" misheard. Short names are left alone: too many near neighbours.
        if len(core) < 5:
            continue
        best = max(((difflib.SequenceMatcher(None, core, n).ratio(), n) for n in names
                    if n[:1] == core[:1] and abs(len(n) - len(core)) <= 2 and len(n) >= 5 and not form(core, n)), default=(0, None))
        if best[0] >= 0.85:
            out[k] = (t, m.group(1) + names[best[1]] + m.group(3))
    return out


def first_sentence(text, most=220):
    """A paragraph's first sentence, or its first two if the first is short."""
    text = " ".join((text or "").split())
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z‘“'\"])", text)
    out = parts[0] if parts else text
    if len(out) < 70 and len(parts) > 1 and len(out) + len(parts[1]) < most:
        out += " " + parts[1]
    return out


RUN_ON = set("""was is are were be been that the a an of to as with for his her their its into on in by at from about
like than who which whose whom calls called call says said offers adds notes quips jokes replies asks remarks recalls
quotes cites puts counters retorts suggests proposes describes declares observes explains warns""".split())


def setup_of(content):
    """A laugh's setup, as the paper prints an overheard line's: who, and the moment, before the words
    themselves (which the caption shows as they are said)."""
    m = re.search(r"(?:^|(?<=[\s(:—-]))[‘'\"“]", content)
    pre = (content[:m.start()] if m else first_sentence(content, 160)).strip()
    pre = re.sub(r"[\s:,;—-]+$", "", pre)
    pre = re.sub(r"\s+(so|and|but|that|says|said|saying|with|as|then|calls it|replies)$", "", pre)
    pre = re.sub(r"[\s:,;—-]+$", "", pre)
    pre = re.sub(r"(?<=[.!?])\s+[A-Z]\w+$", "", pre)   # "…policy. Amit": the name begins what the caption shows
    if len(pre) > 150:
        head = pre.split(":")[0]
        pre = head if len(head) <= 90 else ""
    if len(pre) < 8:
        return ""
    # a setup that runs on into the words ("Naipaul's remark that Gandhi was") leads into the caption
    tail = pre.rsplit(None, 1)[-1]
    return pre + "…" if tail in RUN_ON else pre


def words_in(D, a, b):
    """The episode's words that start in [a, b) centiseconds, as (cs, word, speaker)."""
    W = D["words"]
    t, out = 0, []
    for dt, w, s in zip(W["t"], W["w"], W["s"]):
        t += dt
        if t >= b:
            break
        if t >= a:
            out.append((t, w, s))
    return out


def posters(n, media):
    """Frames of each host from the edition's own pictures (video frames, not Commons photographs),
    and its opening shot."""
    by = {0: [], 1: []}
    lead = (media.get("lead") or {}).get("poster")

    def walk(x):
        if isinstance(x, dict):
            src = x.get("poster")
            cap = x.get("caption") or ""
            if src and (x.get("video") or x.get("t") is not None):
                if cap.startswith("Amit Varma"):
                    by[0].append(src)
                elif cap.startswith("Ajay Shah"):
                    by[1].append(src)
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(media)
    return by, lead


def stable(s):
    return int(hashlib.sha1(s.encode()).hexdigest()[:12], 16)


def main():
    index = load(SITE, "editions", "index.json")
    works = load(DATA, "generated", "analysis", "reading_list.json")["items"]
    work_of = {m: w for w in works for m in w["mentions"]}
    covers = load(SITE, "covers", "index.json")
    big = load(DATA, "generated", "analysis", "big_ideas.json")["ideas"]
    best = load(DATA, "generated", "analysis", "best_of.json")
    eps, nuggets = {}, {}
    for e in index["editions"]:
        n = e["n"]
        ed = os.path.join(SITE, "editions", f"{n:03d}")
        D = load(ed, "data.json")
        E = load(ed, "edition.json")
        media = load(ed, "media.json")
        ins = load(DATA, "generated", "insights", f"{n:03d}.json")
        ep = D["episode"]
        eps[n] = {"n": n, "title": ep["title"], "head": e["head"], "date": ep["date"], "v": ep["videoId"],
                  "s": ep["seconds"], "chapters": [c["title"] for c in ep["chapters"]]}
        printed = {}
        for s in spots(E, n):
            if s.get("item") and s["item"] not in printed:
                printed[s["item"]] = s
        by, lead = posters(n, media)
        story_pic = {}
        for s in (E.get("p3") or {}).get("stories", []):
            if s.get("item") and (s.get("pic") or {}).get("poster"):
                story_pic[s["item"]] = s["pic"]["poster"]
        for piece in ("second", "third"):
            p = (E.get("p1") or {}).get(piece) or {}
            pic = p.get("pic") or {}
            item = (p.get("quote") or {}).get("item") or ((p.get("listen") or [{}])[0]).get("item")
            if item and pic.get("poster"):
                story_pic.setdefault(item, pic["poster"])
        for it in D["items"]:
            if "clip" not in it:
                continue
            iid, k = it["id"], it["id"][4]
            src = ins[KINDS[k]][int(iid[5:]) - 1]
            a, b = it["clip"]
            said = [(t - a, w) for t, w, _ in words_in(D, a, b)]
            said = clean_said(said)
            quote = src.get("quote") if k in "SC" else None
            if k == "J":
                frags = re.findall(r"(?:^|(?<=[\s(:—-]))[‘'\"“](.+?)[’'\"”](?=[\s.,;:)!?—-]|$)", src["content"])
                quote = max(frags, key=len) if frags else None
            texts = [src.get(f) for f in ("topic", "summary", "insight", "concept", "explanation", "quote", "item", "creator",
                                          "reason", "context", "content", "teller", "recommender")]
            cap = fix_names(align(said, quote), texts)
            x = {"id": iid, "ep": n, "k": k, "spk": it.get("spk", 2), "clip": [a, b], "words": [[t, w] for t, w in cap]}
            if k == "S":
                x.update(head=src["topic"], dek=first_sentence(src["insight"]), more=[src["summary"], src["insight"]])
            elif k == "C":
                x.update(head=src["concept"], dek=first_sentence(src["explanation"]), more=[src["explanation"]])
            elif k == "R":
                w = work_of.get(iid)
                x.update(head=src["item"], by=src.get("creator") or "", type=src.get("type", ""),
                         dek=first_sentence(src["reason"]), more=[src["reason"], src.get("context", "")])
                if w and covers.get(w["id"], {}).get("src"):
                    c = covers[w["id"]]
                    x["cover"] = [c["src"], c["w"], c["h"]]
            else:
                x.update(head=setup_of(src["content"]), dek="", more=[src["content"]], type=src.get("type", ""))
            spot = printed.get(iid)
            if spot:
                x["paper"] = spot["a"]
                if spot["kind"] in ("story", "opinion", "lead") and spot["head"]:
                    x["printed"] = spot["head"]
            x["poster"] = story_pic.get(iid) or (by.get(x["spk"]) or [lead])[stable(iid) % max(1, len(by.get(x["spk"]) or [lead]))]
            x["ch"] = it.get("chapter", 0)
            nuggets[iid] = x

    # ── the orders ──
    # each episode, as said
    by_ep = {}
    for x in sorted(nuggets.values(), key=lambda x: (x["ep"], x["clip"][0])):
        by_ep.setdefault(x["ep"], []).append(x["id"])
    # each big idea, as the show developed it (episode order), its own quote first
    ideas = []
    for idea in big:
        ids = [s for s in dict.fromkeys([idea["quote"]["source"]] + idea["sources"]) if s in nuggets]
        ids = ids[:1] + sorted(ids[1:], key=lambda s: (nuggets[s]["ep"], nuggets[s]["clip"][0]))
        if len(ids) >= 3:
            ideas.append({"id": idea["id"], "name": idea["name"], "ids": ids})
    # the newsreel: the best first (an idea, a story, a laugh, in turn), then everything else, mixed
    firsts = []
    lanes = [[i["ids"][0] for i in ideas], [s["source"] for s in best["stories"]],
             [s["source"] for s in best["jokes"] + best["references"]]]
    lanes = [[s for s in lane if s in nuggets and duration(nuggets[s]) >= LEAST] for lane in lanes]
    while any(lanes):
        for lane in lanes:
            if lane:
                firsts.append(lane.pop(0))
    firsts = list(dict.fromkeys(firsts))
    rest = [x for x in nuggets.values() if x["id"] not in set(firsts) and duration(x) >= LEAST]
    reel = firsts + mix(rest)
    reel = spread(reel, nuggets)
    # one line for the episodes and the orders, then one line a nugget: the desk reads it a line at a
    # time, so it never holds the whole file as objects (search/reels.py)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps({"eps": eps, "orders": {"reel": reel, "ep": by_ep, "ideas": ideas}}, ensure_ascii=False, separators=(",", ":")) + "\n")
        for x in nuggets.values():
            f.write(json.dumps(x, ensure_ascii=False, separators=(",", ":")) + "\n")
    size = os.path.getsize(OUT)
    kinds = {k: sum(1 for x in nuggets.values() if x["k"] == k) for k in "SCRJ"}
    print(json.dumps({"nuggets": len(nuggets), "kinds": kinds, "newsreel": len(reel), "ideas": len(ideas),
                      "bytes": size}))


def duration(x):
    return (x["clip"][1] - x["clip"][0]) / 100


def mix(rest):
    """Everything else: stories, ideas and laughs in turn, a recommendation every fifth, each kind in a
    stable shuffle (the same for every reader, so a shared place in the reel means the same nugget)."""
    lanes = {k: sorted([x for x in rest if x["k"] == k], key=lambda x: stable(x["id"])) for k in "SCJR"}
    pattern = "SCJSCRJCS"   # per nine: three stories, three ideas, two laughs, one recommendation
    out = []
    while any(lanes.values()):
        for k in pattern:
            if lanes[k]:
                out.append(lanes[k].pop(0)["id"])
    return out


def spread(order, nuggets, gap=6):
    """No episode twice within `gap` places, and no voice three times running, where it can be helped:
    a nugget that would break that waits for the next place it fits."""
    out, wait = [], []
    queue = list(order)

    def fits(i):
        x = nuggets[i]
        if any(nuggets[o]["ep"] == x["ep"] for o in out[-gap:]):
            return False
        if len(out) >= 2 and all(nuggets[o]["spk"] == x["spk"] for o in out[-2:]):
            return False
        return True
    while queue or wait:
        for k, i in enumerate(wait):
            if fits(i):
                out.append(wait.pop(k))
                break
        else:
            if not queue:
                out.append(wait.pop(0))
                continue
            i = queue.pop(0)
            if fits(i):
                out.append(i)
            else:
                wait.append(i)
    return out


if __name__ == "__main__":
    main()
