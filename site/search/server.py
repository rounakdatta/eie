#!/usr/bin/env python3
"""The archive desk: half-remember something from the show, describe it, and be sent to where it was
printed. A reader's words find a few dozen candidates among every place in every edition (spots.py),
by their words and by the hooks Claude wrote for each (hooks.py); then Claude, reading those
candidates, picks the ones meant, best first, with a line on each.

  GET /api/search?q=the push-ups penance   ->  {"results": [{"ep": 45, "a": "ryan", "url": "45/#ryan", ...}], "mode": "ai"}
  GET /api/asked                           ->  {"total": 1234, "asked": [{"q": "…", "n": 3, "t": "…"}]}
  GET /api/health

Every search is written down (DATA/searches.jsonl, one line each: when, the question, how it was
answered and where it led; never who asked). The questions other readers may see, the ones the page
floats along the search bar, are those that found something and that Claude, reading the question with
its candidates, judged fit to show: a genuine question about the show, with no one's personal details
and nothing offensive. A filter here refuses links, addresses and numbers that look like phones too.

Standard library only: it runs as a sidecar beside nginx in eie.taptappers.club's pod, on the files
nginx serves (SITE, the published site) and the hooks (HOOKS), and asks auth2api in-cluster (AUTH2API,
key in AUTH2API_KEY). When Claude can't be asked (no key, a limit reached, a slow or failed call), the
words alone answer, and the reply says so ("mode": "words").

  SITE=/tmp/pub HOOKS=site/search/hooks AUTH2API_KEY=... python3 site/search/server.py   # then :8090/api/search?q=…
"""
import collections
import json
import math
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from spots import spots  # noqa: E402

SITE = os.environ.get("SITE", "/site")
HOOKS = os.environ.get("HOOKS", os.path.join(HERE, "hooks"))
PORT = int(os.environ.get("PORT", "8090"))
AUTH2API = os.environ.get("AUTH2API", "http://auth2api.apps.svc.cluster.local:8317")
KEY = os.environ.get("AUTH2API_KEY", "").strip()
MODEL = os.environ.get("MODEL", "claude-haiku-4-5")
WIDEN_ON = os.environ.get("WIDEN") == "1"
DATA = os.environ.get("DATA", "/data")   # where every search is logged; none, if it can't be written
ORIGINS = {"https://eie.taptappers.club", "https://rounak.taptappers.club"} | set(filter(None, os.environ.get("ORIGINS", "").split(",")))
# Claude-read searches a reader may make: 8 a minute, 150 a day; and everyone together, 900 an hour.
# Past those, the words alone answer. (LIMITS="minute,day,hour" changes them, for a test.)
_lim = [int(x) for x in os.environ.get("LIMITS", "8,150,900").split(",")]
PER_IP = (_lim[0], 60), (_lim[1], 86400)
GLOBAL = (_lim[2], 3600)
CANDIDATES = 40

STOP = set("""a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if
in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she
should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we
were what when where which while who whom why will with would you your yours yourself yourselves thing things something someone one ones
said says say also like get got episode bit part remember think thought talk talked talking about where""".split())


def stem(w):
    for suf, rep in (("ies", "y"), ("ied", "y"), ("ing", ""), ("edly", ""), ("ed", ""), ("es", ""), ("s", ""), ("ly", "")):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: len(w) - len(suf)] + rep
    return w


def words(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"(\w)'s\b", r"\1", s.replace("’", "'"))
    return [stem(w) for w in re.findall(r"[a-z0-9]+", s) if w not in STOP and len(w) > 1]


class Index:
    """BM25 over every spot: its headline and hooks count for more than its body."""

    def __init__(self):
        self.spots, self.editions = [], {}
        index = json.load(open(os.path.join(SITE, "editions.json"), encoding="utf-8"))
        for e in index["editions"]:
            n = e["n"]
            try:
                E = json.load(open(os.path.join(SITE, str(n), "edition.json"), encoding="utf-8"))
            except FileNotFoundError:
                continue
            self.editions[n] = {"n": n, "date": e["date"], "head": e["head"], "title": e["title"]}
            hooks = {}
            hp = os.path.join(HOOKS, f"{n:03d}.json")
            if os.path.exists(hp):
                hooks = json.load(open(hp, encoding="utf-8"))
            for s in spots(E, n):
                s["ep"] = n
                s["hooks"] = hooks.get(s["a"], [])
                self.spots.append(s)
        self.docs = []
        for s in self.spots:
            toks = words(s["head"]) * 3 + words(s["kicker"]) * 2 + words(" ".join(s["hooks"])) * 2 + words(s["text"])
            self.docs.append(collections.Counter(toks))
        self.N = len(self.docs)
        self.avg = sum(sum(d.values()) for d in self.docs) / max(1, self.N)
        df = collections.Counter(t for d in self.docs for t in d)
        self.idf = {t: math.log(1 + (self.N - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        self.lens = [sum(d.values()) for d in self.docs]

    def search(self, q, k=CANDIDATES):
        qt = words(q)
        if not qt:
            return []
        ep = re.search(r"\b(?:episode|ep|edition)\s*(\d{1,3})\b", q, re.I)
        ep = int(ep.group(1)) if ep else None
        k1, b = 1.2, 0.75
        scores = []
        for i, d in enumerate(self.docs):
            s = 0.0
            for t in qt:
                f = d.get(t)
                if f:
                    s += self.idf[t] * f * (k1 + 1) / (f + k1 * (1 - b + b * self.lens[i] / self.avg))
            if s:
                if ep and self.spots[i]["ep"] == ep:
                    s *= 1.6
                scores.append((s, i))
        scores.sort(reverse=True)
        out, per = [], collections.Counter()
        for s, i in scores:   # no edition crowds out the rest
            n = self.spots[i]["ep"]
            if per[n] >= 4:
                continue
            per[n] += 1
            out.append((s, self.spots[i]))
            if len(out) >= k:
                break
        return out


WIDEN = """A reader is looking for something in the archive of Everything is Everything, a podcast in which
Amit Varma and Ajay Shah talk about economics, history, Indian policy, books, ideas and their own lives.
They describe it, vaguely: “{q}”

List up to 14 words or short phrases likely to appear in the piece they mean: synonyms, and the specific
names and terms their vague words point to (“cricket team stopped trying” → Test match, batting, draw,
blocking, innings; “prices carry information” → Hayek, price signals, knowledge problem, planning).
Reply with the terms alone, on one line, separated by commas."""


def widen(q):
    """The reader's words, and the words the piece itself may use: one quick call."""
    body = json.dumps({"model": MODEL, "max_tokens": 120, "messages": [{"role": "user", "content": WIDEN.format(q=q)}]}).encode()
    req = urllib.request.Request(f"{AUTH2API}/v1/messages", data=body, headers={
        "x-api-key": KEY, "content-type": "application/json", "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=6) as r:
        reply = json.loads(r.read())
    text = "".join(b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text")
    return " ".join(t.strip() for t in text.replace("\n", ",").split(",") if t.strip())[:600]


DESK = """You are the archive desk of a newspaper made from all 128 episodes of the podcast Everything is
Everything, in which Amit Varma and Ajay Shah talk about economics, history, ideas and their own lives.
A reader half-remembers something and has described it, vaguely and perhaps wrongly in the details:

“{q}”

Below are places in the archive that might be it: a story, an opinion section, an In Brief item, a
number, a book on the shelf, a laugh line, a word, listed roughly by how well their words match. Each
says how readers remember it. Match on meaning, not on words: the gist, the shape of the story, who told
it. Pick the places the reader most likely means, best first, at most five. Prefer the place that is about
the thing itself over one that only mentions it; for a fact or a figure, the number or the In Brief item
that states it; for a book, film or episode recommended, its place on the shelf. If
nothing plausibly matches, pick none. For each pick write a "note" of at most 16 words, warmly and plainly,
as an archivist would: what the reader will find there, with its people and its memorable detail, and
how it answers what they asked. Never repeat the headline; never invent what the place doesn't say.
For example: “Amit's college friend Ryan, who did 25 push-ups as penance for every lapse”.

Then say whether the reader's words may be shown to other readers, as one of the questions people have
asked (“show”): true only for a genuine question about the show's ideas, stories, people, books or jokes,
worded so a stranger would be curious; false for anything with a private person's name or details, a
link, contact details, abuse, crudity, a test or gibberish, or anything that isn't about the show.

Reply with JSON alone: {{"picks": [{{"n": 3, "note": "..."}}], "show": true}}

The places:
{places}"""


def place(i, s, eds):
    e = eds[s["ep"]]
    body = " ".join(s["lede"].split()[:45])
    seen = "; ".join(s["hooks"][:5])
    return (f"{i}. Episode {s['ep']} (“{e['title']}”), page {s['page']}, {s['kind']}: "
            f"{s['head']}{' — ' + s['kicker'] if s['kicker'] else ''}. {body}" + (f" [Remembered as: {seen}]" if seen else ""))


def ask(q, cands, eds):
    places = "\n".join(place(i + 1, s, eds) for i, (_, s) in enumerate(cands))
    body = json.dumps({"model": MODEL, "max_tokens": 700, "messages": [{"role": "user", "content": DESK.format(q=q, places=places)}]}).encode()
    req = urllib.request.Request(f"{AUTH2API}/v1/messages", data=body, headers={
        "x-api-key": KEY, "content-type": "application/json", "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=14) as r:
        reply = json.loads(r.read())
    text = "".join(b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text")
    reply = json.loads(text[text.index("{"):text.rindex("}") + 1])
    picks, show = reply.get("picks", []), reply.get("show") is True
    out = []
    for p in picks:
        n = p.get("n")
        if isinstance(n, int) and 1 <= n <= len(cands) and all(cands[n - 1][1] is not x for x, _ in out):
            out.append((cands[n - 1][1], (p.get("note") or "").strip()[:160]))
    return out[:5], show


class Limits:
    def __init__(self):
        self.lock = threading.Lock()
        self.ip = collections.defaultdict(collections.deque)
        self.all = collections.deque()

    def take(self, ip):
        """May this reader's search be read by Claude now? Counts it if so."""
        now = time.time()
        with self.lock:
            q = self.ip[ip]
            while q and now - q[0] > PER_IP[1][1]:
                q.popleft()
            while self.all and now - self.all[0] > GLOBAL[1]:
                self.all.popleft()
            recent = sum(1 for t in q if now - t <= PER_IP[0][1])
            if recent >= PER_IP[0][0] or len(q) >= PER_IP[1][0] or len(self.all) >= GLOBAL[0]:
                return False
            q.append(now)
            self.all.append(now)
            if len(self.ip) > 20000:   # forget the quiet
                for k in [k for k, v in self.ip.items() if not v or now - v[-1] > 86400]:
                    del self.ip[k]
            return True


# never floated for others, whatever the verdict: links, addresses, long runs of digits (a phone), and a
# few words no reader should meet in a newspaper's margin
UNFIT = re.compile(r"(https?:|www\.|\.(com|in|org|net)\b|@|\d[\d\s-]{6,}\d)", re.I)
CRUDE = set("""fuck fucking fucker shit shitty cunt bitch bastard dick cock pussy whore slut nigger nigga faggot fag
retard retarded chutiya chutiye madarchod behenchod bhenchod bhosdike randi gandu lund""".split())


def fit(q):
    """May this question be floated for other readers, its verdict aside?"""
    w = re.findall(r"[a-z']+", q.lower())
    return 6 <= len(q) <= 90 and 2 <= len(q.split()) <= 16 and not UNFIT.search(q) and not CRUDE & set(w)


class Asked:
    """Every search, written down; and the questions fit to float for other readers, most recent first."""

    def __init__(self):
        self.lock = threading.Lock()
        self.total = 0
        self.shown = collections.OrderedDict()   # normalised -> {"q", "n", "t"}, oldest first
        self.path = os.path.join(DATA, "searches.jsonl")
        try:
            os.makedirs(DATA, exist_ok=True)
            with open(self.path, "a", encoding="utf-8"):
                pass
        except OSError as e:
            print(json.dumps({"log": "off", "why": str(e)[:120]}), flush=True)
            self.path = None
        if self.path:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    try:
                        self.count(json.loads(line))
                    except ValueError:
                        continue

    def count(self, e):
        self.total += 1
        if e.get("show") and e.get("n") and fit(e["q"]):
            k = " ".join(e["q"].lower().split()).rstrip("?.! ")
            was = self.shown.pop(k, {"q": " ".join(e["q"].split()).rstrip(" "), "n": 0})
            self.shown[k] = {**was, "n": was["n"] + 1, "t": e["t"]}
            while len(self.shown) > 500:
                self.shown.popitem(last=False)

    def note(self, q, out, show, test=False):
        r = out["results"]
        e = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "q": q, "mode": out["mode"], "n": len(r),
             "top": f"{r[0]['ep']}#{r[0]['a']}" if r else None, "show": bool(show) and not test,
             **({"cached": True} if out.get("cached") else {}), **({"test": True} if test else {})}
        with self.lock:
            self.count(e)
            if self.path:
                try:
                    with open(self.path, "a", encoding="utf-8") as f:
                        f.write(json.dumps(e, ensure_ascii=False) + "\n")
                except OSError as err:
                    print(json.dumps({"log": "failed", "why": str(err)[:120]}), flush=True)

    def public(self):
        with self.lock:
            recent = list(reversed(self.shown.values()))[:40]
            return {"total": self.total, "asked": [{"q": x["q"], "n": x["n"], "t": x["t"]} for x in recent]}


INDEX = None
ASKED = None
LIMITS = Limits()
CACHE = collections.OrderedDict()   # a normalised question -> its answer, for a week
CACHE_LOCK = threading.Lock()


def result(s, note, eds):
    e = eds[s["ep"]]
    w = s["lede"].split()
    snip = " ".join(w[:34]) + ("…" if len(w) > 34 else "")
    return {"ep": s["ep"], "a": s["a"], "page": s["page"], "kind": s["kind"], "head": s["head"], "kicker": s["kicker"],
            "snip": snip, "note": note, "date": e["date"], "edition": e["head"], "title": e["title"], "url": f"{s['ep']}/#{s['a']}"}


def answer(q, ip, test=False):
    key = " ".join(words(q)) or q.lower()
    with CACHE_LOCK:
        hit = CACHE.get(key)
        if hit and time.time() - hit[0] < 7 * 86400:
            CACHE.move_to_end(key)
            out = {**hit[1], "cached": True}
            ASKED.note(q, out, hit[2], test)
            return out
    t0 = time.time()
    cands = INDEX.search(q)
    eds = INDEX.editions
    mode, picks, show = "words", None, False
    if KEY and LIMITS.take(ip):
        try:   # the words the piece may use, then candidates by both: the reader's own first (WIDEN=1; it
            # cost 1.4 s a search and changed nothing measurable on 50 vague questions, so it is off)
            if not WIDEN_ON:
                raise LookupError("off")
            more = INDEX.search(f"{q} {widen(q)}", k=CANDIDATES)
            seen, merged = set(), []
            for pair in [x for ab in zip(cands[:24], more[:24]) for x in ab] + cands[24:] + more[24:]:
                if pair[1]["id"] not in seen:
                    seen.add(pair[1]["id"])
                    merged.append(pair)
            cands = merged[:CANDIDATES]
        except LookupError:
            pass
        except Exception as e:
            print(json.dumps({"widen": "failed", "why": f"{type(e).__name__}: {str(e)[:120]}"}), flush=True)
        if cands:
            try:
                picks, show = ask(q, cands, eds)
                mode = "ai"
            except Exception as e:   # the words alone, then
                print(json.dumps({"ask": "failed", "why": f"{type(e).__name__}: {str(e)[:120]}"}), flush=True)
    if picks is None:
        picks = [(s, "") for _, s in cands[:5]]
    out = {"q": q, "mode": mode, "results": [result(s, note, eds) for s, note in picks], "ms": round((time.time() - t0) * 1000)}
    if mode == "ai":   # only a considered answer is worth keeping
        with CACHE_LOCK:
            CACHE[key] = (time.time(), out, show)
            while len(CACHE) > 4000:
                CACHE.popitem(last=False)
    ASKED.note(q, out, show, test)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "eie-desk/1"

    def log_message(self, *a):   # no request line, and so no one's address: the searches log has the questions
        pass

    def send(self, code, obj, cache=0):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"public, max-age={cache}" if cache else "no-store")
        origin = self.headers.get("Origin", "")
        if origin in ORIGINS or origin.startswith("http://127.0.0.1") or origin.startswith("http://localhost"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send(204, {})

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path in ("/api/health", "/health"):
            return self.send(200, {"ok": True, "spots": INDEX.N, "editions": len(INDEX.editions), "hooked": sum(1 for s in INDEX.spots if s["hooks"]),
                                   "ai": bool(KEY), "model": MODEL})
        if u.path in ("/api/asked", "/asked"):
            return self.send(200, ASKED.public(), cache=60)
        if u.path not in ("/api/search", "/search"):
            return self.send(404, {"error": "not here"})
        q = urllib.parse.parse_qs(u.query).get("q", [""])[0]
        q = re.sub(r"[\x00-\x1f\x7f]+", " ", q).strip()[:300]
        if len(q) < 2:
            return self.send(400, {"error": "Describe it in a few words."})
        ip = (self.headers.get("X-Real-Ip") or self.headers.get("X-Forwarded-For", "").split(",")[0] or self.client_address[0]).strip()
        try:
            # a test of the desk (X-Desk-Test) is written down as one, and never floated as a reader's question
            self.send(200, answer(q, ip, test=bool(self.headers.get("X-Desk-Test"))))
        except Exception as e:
            print(json.dumps({"search": "failed", "why": f"{type(e).__name__}: {str(e)[:160]}"}), flush=True)
            self.send(500, {"error": "The desk is closed for a moment. Try again."})


def main():
    global INDEX, ASKED
    t0 = time.time()
    INDEX = Index()
    ASKED = Asked()
    print(json.dumps({"desk": "open", "port": PORT, "spots": INDEX.N, "editions": len(INDEX.editions),
                      "hooked": sum(1 for s in INDEX.spots if s["hooks"]), "ai": bool(KEY), "logged": ASKED.total, "log": bool(ASKED.path),
                      "seconds": round(time.time() - t0, 2)}), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
