"""The newsreel's feed: the archive's nuggets, a few at a time, in the order the reel plays them.

  GET /api/reels?n=8                       ->  the newsreel from the top
  GET /api/reels?at=8                      ->  its next page (the reply's "next" says where)
  GET /api/reels?from=045-S01              ->  the newsreel from that nugget (a shared link)
  GET /api/reels?ep=45 | idea=<id> | q=<words> | kind=S,C | who=amit|ajay     filters, any together
  GET /api/reels/state                     ->  {"on": true}: may the reel be offered at all?

Everything it serves was made by site/reels/build.py (reels.jsonl, beside this file): no model is
asked, so a swipe costs a dictionary lookup. Replies are the same for everyone, so they may be cached
publicly, but for a minute only: the switch below must be felt everywhere at once.

The switch: the reel is off when the environment says REELS=off, or at once, with no deploy, when the
file DATA/reels.off exists (`touch` it in the desk container; `rm` it to turn the reel back on). Off,
every reel request answers 503 {"off": true}, and the pages that offer the reel stop offering it.
"""
import array
import collections
import json
import math
import os
import re
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KINDS = {"S", "C", "R", "J"}
WHO = {"amit": 0, "ajay": 1}
PAGE, MOST = 8, 20
SEARCH_MOST = 120   # a search is a short reel: its best matches, best first


class Reels:
    """Held compactly: each nugget's reply already written as JSON (the desk shares a pod on a node short
    of memory, and 6,423 nuggets as Python objects took 71 MB; as text they take a tenth of that), what
    the filters need as small tuples, and the search as an inverted index in packed arrays."""

    def __init__(self, words, path=None, data="/data"):
        self.words = words
        f = open(path or os.path.join(HERE, "reels.jsonl"), encoding="utf-8")
        R = json.loads(f.readline())
        self.eps = {int(k): {"head": v["head"], "title": v["title"]} for k, v in R["eps"].items()}
        self.reel = R["orders"]["reel"]
        self.by_ep = {int(k): v for k, v in R["orders"]["ep"].items()}
        self.ideas = {i["id"]: i for i in R["orders"]["ideas"]}
        self.off_file = os.path.join(data, "reels.off")
        self.env_off = os.environ.get("REELS", "on").strip().lower() == "off"
        self.meta, self.blob, self.ids = {}, {}, []
        postings = collections.defaultdict(lambda: (array.array("I"), array.array("H")))
        lens = array.array("I")
        for line in f:
            x = json.loads(line)
            i = x["id"]
            e = R["eps"][str(x["ep"])]
            x = dict(x, v=e["v"], title=e["title"], date=e["date"], edition=e["head"])
            x["chapter"] = e["chapters"][x.pop("ch", 0)] if e["chapters"] else ""
            self.meta[i] = (x["k"], x["spk"], x["ep"])
            self.blob[i] = json.dumps(x, ensure_ascii=False, separators=(",", ":"))
            # BM25 over its headline (thrice), its lines and its words as said
            text = " ".join([x.get("dek", ""), *(x.get("more") or []), " ".join(w for _, w in x["words"]), x.get("by", "")])
            tf = collections.Counter(words(x["head"]) * 3 + words(text))
            d = len(self.ids)
            self.ids.append(i)
            lens.append(sum(tf.values()))
            for t, c in tf.items():
                docs, tfs = postings[t]
                docs.append(d)
                tfs.append(min(c, 65535))
        f.close()
        del R
        self.postings = dict(postings)
        self.lens = lens
        self.avg = sum(lens) / max(1, len(lens))
        N = len(self.ids)
        self.idf = {t: math.log(1 + (N - len(p[0]) + 0.5) / (len(p[0]) + 0.5)) for t, p in self.postings.items()}
        self.lock = threading.Lock()
        self.seen = collections.defaultdict(collections.deque)

    def on(self):
        return not self.env_off and not os.path.exists(self.off_file)

    def allow(self, ip, most=90, per=300):
        """A reader may ask 90 times in five minutes (Traefik's edge limit is the first line: one a second)."""
        now = time.time()
        with self.lock:
            q = self.seen[ip]
            while q and now - q[0] > per:
                q.popleft()
            if len(q) >= most:
                return False
            q.append(now)
            self.calls = getattr(self, "calls", 0) + 1
            if self.calls % 2000 == 0 or len(self.seen) > 20000:   # forget the quiet now and then
                for k in [k for k, v in self.seen.items() if not v or now - v[-1] > per]:
                    del self.seen[k]
            return True

    def search(self, q):
        k1, b = 1.2, 0.75
        score = collections.defaultdict(float)
        for t in set(self.words(q)):
            p = self.postings.get(t)
            if not p:
                continue
            idf = self.idf[t]
            for d, f in zip(*p):
                score[d] += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * self.lens[d] / self.avg))
        if not score:
            return []
        ranked = sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))
        top = ranked[0][1]
        # what matches the words in earnest, not only one of them in passing
        return [self.ids[d] for d, s in ranked[:SEARCH_MOST] if s >= 0.25 * top]

    def order(self, p):
        """The ids this reel plays, and a name for it."""
        kinds = {k for k in (p.get("kind") or "").upper().split(",") if k in KINDS}
        who = WHO.get((p.get("who") or "").lower())
        ep, idea, q = p.get("ep"), p.get("idea"), (p.get("q") or "").strip()[:120]
        name = "The newsreel"
        if q:
            ids, name = self.search(q), f"“{q}”"
        elif idea in self.ideas:
            ids, name = self.ideas[idea]["ids"], self.ideas[idea]["name"]
        elif ep and str(ep).isdecimal() and int(ep) in self.by_ep:
            n = int(ep)
            ids, name = self.by_ep[n], f"No. {n}: {self.eps[n]['head']}"
        else:
            ids = self.reel
        if kinds:
            ids = [i for i in ids if self.meta[i][0] in kinds]
        if who is not None:
            ids = [i for i in ids if self.meta[i][1] == who]
        return ids, name

    def page(self, p):
        """A page of the reel, as the JSON text of the reply."""
        ids, name = self.order(p)
        n = int(p["n"]) if str(p.get("n", "")).isdecimal() else PAGE
        n = max(1, min(MOST, n))
        start = p.get("from")
        lead = []
        if start in self.blob:
            if start in ids:
                at = ids.index(start)
            else:   # a nugget this reel doesn't hold (a shared one, under a filter): it leads, then the reel
                lead, at = [start], 0
        else:
            at = int(p["at"]) if str(p.get("at", "")).isdecimal() else 0
        chunk = lead + ids[at:at + n - len(lead)]
        nxt = at + n - len(lead)
        head = {"name": name, "total": len(ids) + len(lead), "at": at, "next": nxt if nxt < len(ids) else None}
        if lead:
            head["lead"] = True
        return json.dumps(head, ensure_ascii=False)[:-1] + ',"items":[' + ",".join(self.blob[i] for i in chunk) + "]}"

    def menu(self):
        """What the reel can be narrowed to: the big ideas by name, the episodes by number."""
        return {"ideas": [{"id": k, "name": v["name"], "n": len(v["ids"])} for k, v in self.ideas.items()],
                "eps": [{"n": n, "head": e["head"], "title": e["title"], "count": len(self.by_ep.get(n, []))}
                        for n, e in sorted(self.eps.items())],
                "total": len(self.reel)}


def params(query):
    """The query string's first value for each key, without control characters."""
    import urllib.parse
    out = {}
    for k, v in urllib.parse.parse_qs(query).items():
        if v:
            out[k] = re.sub(r"[\x00-\x1f\x7f]+", " ", v[0]).strip()[:200]
    return out
