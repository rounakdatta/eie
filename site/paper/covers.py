#!/usr/bin/env python3
"""Covers for the shelf: the front cover, poster or sleeve of each book, film, series, album, song and
podcast the hosts recommended, to sit beside it on page four.

  python3 site/paper/covers.py                 # every such work with no verdict yet
  python3 site/paper/covers.py --only=ID,ID    # these works again (reading-list ids)
  python3 site/paper/covers.py --limit=20      # the first few, to try it

Writes site/covers/<id>.jpg (300 px tall) and site/covers/index.json, one entry a work:
  {"src": "<id>.jpg", "w": 200, "h": 300, "source": "Open Library", "page": "<where it came from>"}
  or {"none": ["why each candidate was refused", ...]} when no picture passed.

Where they come from:
- books: the edition the hosts linked (an Amazon link's own cover), else Open Library's search, else
  the cover Wikipedia shows on the book's page;
- films and series: Wikipedia, the page's own picture, when Wikipedia describes the page as a film or
  a series and its title matches;
- albums, songs and podcasts: a Spotify link's own artwork, else Apple's iTunes Search, when the title
  and the artist both match.

Every picture is looked at by Claude before it is kept. It must be the front cover (any edition) of
that book, a poster or title card of that film or series, the sleeve of that album (or of the record a
song is on), or the artwork of that podcast. A different work, a back cover, a placeholder or a
photograph of the author is refused, and the next candidate is tried. Works carry no links, so a work's
links are read from the built editions' shelves.

Needs Pillow and anthropic (work/venv; `. work/env.sh` first) and the auth2api key in work/.auth2api-key.
"""
import difflib
import glob
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

import anthropic
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
OUT = os.path.join(SITE, "covers")
sys.path.insert(0, HERE)
from media import GATEWAY, UA, jpeg, look   # noqa: E402  (the same Claude, called the same way)

KINDS = {"book", "film", "tv", "album", "song", "podcast"}
HEIGHT = 300   # stored height: a cover is shown 66-88 px tall, so this is sharp at 3x
PAUSE = {"openlibrary.org": 1.0, "en.wikipedia.org": 1.0, "itunes.apple.com": 3.5, "open.spotify.com": 1.0, "m.media-amazon.com": 1.0}
_last = {}

COVER = """Each numbered picture below was found as the cover of the work named beside its number. For each, say:
- "fits": true if it is plausibly the front cover of that book (any edition, translation or format), a
  poster, DVD cover or title card of that film or series, the sleeve of that album (for a song: the
  sleeve of the album or single it came out on), or the artwork of that podcast. Judge by the title
  and names printed on it where there are any, and by what can be seen.
- "kind": "front cover", "poster", "title card", "sleeve", "artwork", "back cover", "spine",
  "photo of a person", "placeholder", "page of text" or "other".
- "why": a few words.
Refuse (fits false): a different work (another book by the same author, a different film of the same
name, a different album), a back cover or spine, a blank or generic placeholder, a library stamp or
catalogue card, a photograph of the author or a scene that is not a poster, a page of text, a collage
of several covers, or a picture too blurred or cut off to tell what it is. A cover in another language
is fine if its title is plainly the same work.

Reply with JSON alone: {"pictures": [{"n": 1, "fits": true, "kind": "front cover", "why": "title and author match"}, ...]}"""


def norm(s):
    """Lower case, no accents, no punctuation, no leading article: for comparing titles and names."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"&", " and ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"^(the|a|an) ", "", s.strip())
    return re.sub(r"\s+", " ", s).strip()


def main_title(t):
    """The title without its subtitle or a bracketed note: "The Fatal Conceit: The Errors of Socialism"."""
    t = re.sub(r"\s*\([^)]*\)\s*$", "", t)
    return re.split(r"\s*[:–—]\s+|\s+-\s+", t)[0].strip()


def like(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def same(found, title):
    """Is a found title the work's? The main titles alike, or one wholly inside the other ("Dan Carlin's
    Hardcore History" is Hardcore History)."""
    a, b = norm(main_title(found)), norm(main_title(title))
    if not a or not b:
        return False
    if like(a, b) >= 0.85:
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 6 and f" {short} " in f" {long_} "


def surnames(creator):
    """The family names in a credit line ("Vijay Kelkar and Ajay Shah" → kelkar, shah)."""
    people = re.split(r",| and | & |;| with ", creator or "")
    return {norm(p).split()[-1] for p in people if norm(p)}


def get(url, params=None, raw=False):
    host = urllib.parse.urlsplit(url).netloc
    wait = PAUSE.get(host, 0.5) - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        _last[host] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                b = r.read()
            return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(20 * (attempt + 1))
                continue
            raise


# ── where a cover may be found, best first ──────────────────────────────────────────────────────

def amazon(links):
    """The cover of the very edition the hosts linked: an Amazon link's ASIN, and Amazon's image for it."""
    for u in links:
        host = urllib.parse.urlsplit(u).netloc
        if not re.search(r"(^|\.)(amzn\.(in|eu|to|com)|amazon\.[a-z.]+)$", host):
            continue
        asin = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})(?:[/?]|$)", u)
        if not asin:   # a short link (amzn.in/d/…) is read from its redirect, never followed to amazon.in
            time.sleep(1.0)
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})   # a HEAD gets a 404 here
                opener = urllib.request.build_opener(NoRedirect)
                r = opener.open(req, timeout=20)
                loc = r.headers.get("Location", "")
            except urllib.error.HTTPError as e:
                loc = e.headers.get("Location", "") if e.code in (301, 302, 303, 307, 308) else ""
            except Exception:
                loc = ""
            asin = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", loc)
        if asin:
            a = asin.group(1)
            yield {"url": f"https://m.media-amazon.com/images/P/{a}.01._SCLZZZZZZZ_.jpg", "source": "Amazon", "page": f"https://www.amazon.in/dp/{a}"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def books(w, links):
    title, names = main_title(w["title"]), surnames(w["creator"])
    yield from amazon(links)
    seen = set()
    for params in ({"title": title, "author": " ".join(sorted(names))}, {"q": f"{title} {' '.join(sorted(names))}".strip()}, {"title": title}):
        if not names and "author" in params:
            continue
        try:
            docs = get("https://openlibrary.org/search.json", {**params, "fields": "key,title,author_name,cover_i,edition_count", "limit": 10})["docs"]
        except Exception:
            docs = []
        scored = []
        for d in docs:
            if not d.get("cover_i") or d["cover_i"] in seen:
                continue
            authors = {norm(a).split()[-1] for a in d.get("author_name", []) if norm(a)}
            # an author named only in another script (Plato as Πλάτων) can't be compared: the title decides,
            # and the look at the cover after
            if names and authors and not names & authors:
                continue
            if not same(d.get("title", ""), title):
                continue
            scored.append((-(d.get("edition_count") or 1), d))
        for _, d in sorted(scored, key=lambda x: x[0])[:2]:
            seen.add(d["cover_i"])
            yield {"url": f"https://covers.openlibrary.org/b/id/{d['cover_i']}-L.jpg?default=false", "source": "Open Library",
                   "page": f"https://openlibrary.org{d['key']}"}
    yield from wikipedia(w, links, ("book", "novel", "memoir", "essay", "non-fiction", "nonfiction", "treatise", "biography", "autobiography"))


def screen(w, links):
    return wikipedia(w, links, ("film", "series", "sitcom", "miniseries", "documentary", "television", "tv ", "show"))


def wikipedia(w, links, kinds):
    """The picture Wikipedia shows for the work's own page: a film's poster, a book's cover."""
    title = main_title(w["title"])
    kind = {"film": "film", "tv": "television series", "book": "book"}.get(w["type"], "")
    out, seen = [], set()
    wiki = [u for u in links if "wikipedia.org/wiki/" in u]
    names = [urllib.parse.unquote(u.split("/wiki/", 1)[1]).replace("_", " ") for u in wiki]
    # the page a work usually has, asked for by name ("The Godfather (film)", "The Wire"), before a search,
    # whose results can be every page but the work's own
    names += [f"{title} ({k})" for k in {"film": ("film",), "tv": ("TV series", "miniseries"), "book": ("book", "novel")}.get(w["type"], ())] + [title]
    try:
        hits = get("https://en.wikipedia.org/w/api.php", {"action": "query", "list": "search", "format": "json", "srlimit": 5,
                                                         "srsearch": f'"{title}" {kind} {w["creator"]}'.strip()})["query"]["search"]
        names += [h["title"] for h in hits]
    except Exception:
        pass
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        try:
            pages = get("https://en.wikipedia.org/w/api.php", {"action": "query", "format": "json", "prop": "pageprops|pageimages",
                                                              "piprop": "original|thumbnail", "pithumbsize": 600, "pilicense": "any", "redirects": 1,
                                                              "titles": name})["query"]["pages"]
        except Exception:
            continue
        for p in pages.values():
            desc = (p.get("pageprops") or {}).get("wikibase-shortdesc", "").lower()
            bare = re.sub(r"\s*\([^)]*\)$", "", p.get("title", ""))
            if p.get("original") and any(k in desc for k in kinds) and same(bare, title):
                src = p["original"]["source"]
                if urllib.parse.urlsplit(src).path.lower().endswith(".svg") and p.get("thumbnail"):   # a drawn title card: its rendering, not the SVG
                    src = p["thumbnail"]["source"]
                out.append({"url": src, "source": "Wikipedia", "exact": norm(main_title(bare)) == norm(title),
                            "page": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(p['title'].replace(' ', '_'))}"})
        if len(out) >= 3:
            break
    # the page whose title is the work's own first ("The Godfather" before "The Godfather Part III")
    return sorted(out, key=lambda c: not c.pop("exact"))


def records(w, links):
    title, names, out = main_title(w["title"]), surnames(w["creator"]), []
    for u in links:
        if "open.spotify.com/" in u and ("/album/" in u or "/show/" in u or "/track/" in u):
            try:
                o = get("https://open.spotify.com/oembed", {"url": u.split("?")[0]})
                if o.get("thumbnail_url"):
                    out.append({"url": o["thumbnail_url"], "source": "Spotify", "page": u.split("?")[0]})
            except Exception:
                pass
    entity = {"album": "album", "song": "song", "podcast": "podcast"}[w["type"]]
    try:
        res = get("https://itunes.apple.com/search", {"term": f"{title} {w['creator']}".strip(), "entity": entity, "limit": 8})["results"]
    except Exception:
        res = []
    for r in res:
        name = r.get("trackName") if entity == "song" else r.get("collectionName")
        artist = norm(r.get("artistName", ""))
        if not name or not same(name, title):
            continue
        if names and w["type"] != "podcast" and not any(n in artist.split() for n in names):   # a podcast's publisher is rarely its host
            continue
        art = r.get("artworkUrl600") or r.get("artworkUrl100", "")
        if art:
            out.append({"url": re.sub(r"/\d+x\d+bb\.", "/600x600bb.", art), "source": "Apple",
                        "page": r.get("collectionViewUrl") or r.get("trackViewUrl") or ""})
        if len(out) >= 3:
            break
    return out


FIND = {"book": books, "film": screen, "tv": screen, "album": records, "song": records, "podcast": records}


# ── the run ─────────────────────────────────────────────────────────────────────────────────────

def picture(cand):
    """The candidate as an image, or why not."""
    try:
        im = Image.open(io.BytesIO(get(cand["url"], raw=True)))
        im.load()
    except Exception as e:
        return None, f"fetch: {str(e)[:80]}"
    if im.width < 90 or im.height < 90:
        return None, f"too small ({im.width}x{im.height})"
    im = im.convert("RGB")
    r = im.height / im.width
    if not 0.55 <= r <= 2.0:   # a strip or a banner is not a cover
        return None, f"shape {im.width}x{im.height}"
    return im, None


def label(w):
    what = {"book": "the book", "film": "the film", "tv": "the series", "album": "the album", "song": "the song", "podcast": "the podcast"}[w["type"]]
    by = f" by {w['creator']}" if w["creator"] else ""
    return f"{what} “{w['title']}”{by}"


def main(args):
    opt = lambda k: next((a.split("=", 1)[1] for a in args if a.startswith(f"--{k}=")), None)
    os.makedirs(OUT, exist_ok=True)
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    works = [w for w in json.load(open(os.path.join(ROOT, "data", "generated", "analysis", "reading_list.json")))["items"] if w["type"] in KINDS]
    links = {}
    for f in glob.glob(os.path.join(SITE, "editions", "[0-9][0-9][0-9]", "edition.json")):
        for b in json.load(open(f))["shelf"]:
            if b.get("url"):
                links.setdefault(b["id"], b["url"])
    only = set(opt("only").split(",")) if opt("only") else None
    todo = [w for w in works if (w["id"] in only if only else w["id"] not in index)]
    for w in todo:   # looked for again: the old verdict goes
        index.pop(w["id"], None)
    if opt("limit"):
        todo = todo[:int(opt("limit"))]
    print(f"{len(todo)} works to look for ({len(works)} of these kinds in the reading list)", flush=True)
    with open(os.path.join(ROOT, "work", ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=600)
    log = []

    def save():
        tmp = index_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, index_path)

    for g in range(0, len(todo), 10):   # ten works at a time: find, fetch, then one look at them all
        group = todo[g:g + 10]
        cands = {w["id"]: iter(FIND[w["type"]](w, [links[m] for m in w["mentions"] if m in links])) for w in group}
        refused = {w["id"]: [] for w in group}
        for round_ in range(3):   # the best candidate of each; a refused one makes way for the next
            batch = []
            for w in group:
                while w["id"] not in index and (c := next(cands[w["id"]], None)):
                    im, why = picture(c)
                    if im is None:
                        refused[w["id"]].append(f"{c['source']}: {why}")
                        continue
                    batch.append((w, c, im))
                    break
            if not batch:
                break
            thumbs = [jpeg(im.resize((int(im.width * 360 / im.height), 360)) if im.height > 360 else im) for _, _, im in batch]
            prompt = COVER + "\n\nThe pictures, in order:\n" + "\n".join(f"{k + 1}: {label(w)}" for k, (w, _, _) in enumerate(batch))
            try:
                verdicts = {v.get("n"): v for v in look(client, thumbs, prompt, log).get("pictures", [])}
            except Exception as e:   # no verdict is a refusal, never a crash
                log.append({"call": "look", "error": str(e)[:200]})
                verdicts = {}
            for k, (w, c, im) in enumerate(batch):
                v = verdicts.get(k + 1, {})
                if not v.get("fits"):
                    refused[w["id"]].append(f"{c['source']}: {v.get('kind', '?')} ({v.get('why', 'no verdict')})")
                    continue
                if im.height > HEIGHT:
                    im = im.resize((round(im.width * HEIGHT / im.height), HEIGHT), Image.LANCZOS)
                fn = f"{w['id'][:80]}.jpg"
                im.save(os.path.join(OUT, fn), "JPEG", quality=84, optimize=True, progressive=True)
                index[w["id"]] = {"src": fn, "w": im.width, "h": im.height, "source": c["source"], "page": c["page"], "kind": v.get("kind")}
        for w in group:
            if w["id"] not in index:
                index[w["id"]] = {"none": refused[w["id"]] or ["no candidate found"]}
        save()
        got = sum(1 for w in group if "src" in index[w["id"]])
        print(json.dumps({"done": g + len(group), "of": len(todo), "covers": got, "none": [w["id"] for w in group if "none" in index[w["id"]]]}), flush=True)
    calls = [x for x in log if x.get("call") == "look" and "seconds" in x]
    print(json.dumps({"looks": len(calls), "seconds": sum(x["seconds"] for x in calls), "covers": sum(1 for v in index.values() if "src" in v),
                      "none": sum(1 for v in index.values() if "none" in v)}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
