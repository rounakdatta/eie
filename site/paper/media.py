#!/usr/bin/env python3
"""Pictures for an edition: site/editions/NNN/media.json and site/editions/NNN/media/.

  python3 site/paper/media.py 1 50          # these episodes (each needs its copy.json)
  python3 site/paper/media.py --all         # every edition with a copy and no media.json yet

Needs ffmpeg and yt-dlp on PATH, Pillow and anthropic (work/venv; `. work/env.sh` first), and the
auth2api key in work/.auth2api-key. Every picture is the episode's own or a checked photograph:

- Moving pictures (4 s, silent, looping) and stills from the episode's video, downloaded at 480p,
  video only, and deleted when done: the two hosts together near the start for the lead; whoever is
  speaking, in close-up, for each story and idea the copy pictures.
- Chapter cards at the start of each chapter the opinion page uses (the art the show notes credit).
- Portraits and photographs from Wikimedia Commons: Wikidata's image for the person or subject the
  copy names, taken only when Wikidata's description fits the copy's hint, with the author and
  licence from Commons for the credit.

Which frame shows whom is read off contact sheets of numbered candidate frames by Claude, against a
reference sheet of the two hosts, by appearance; code turns that into names. A loop is cut only where
the camera holds for its four seconds. Every caption names who is actually on screen.
"""
import base64
import concurrent.futures
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import anthropic
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
EDITIONS = os.path.join(SITE, "editions")
WORK = os.path.join(ROOT, "work", "media")
LOGS = os.path.join(ROOT, "work", "editions", "media-logs")
GATEWAY = "http://auth2api.apps.svc.cluster.local:8317"
MODEL = "claude-opus-5-5"
UA = "EiE-newspaper/1.0 (https://github.com/rounakdatta/eie)"
sys.path.insert(0, SITE)
sys.path.insert(0, HERE)
import build  # noqa: E402
import copydesk as C  # noqa: E402
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("build_paper", os.path.join(HERE, "build-paper.py"))
BP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(BP)

FFMPEG, YTDLP = shutil.which("ffmpeg"), shutil.which("yt-dlp")
HOSTS = ["Amit Varma", "Ajay Shah"]
LOOK = {0: "B", 1: "A"}   # on the reference sheet, A is Ajay Shah (the older man) and B is Amit Varma

CLASSIFY = """The first image is a reference sheet of the two hosts of a video podcast, on its
different sets over the years. A is the older man with grey or white hair (in early episodes a white
beard) and glasses. B is the younger man with black hair and dark-rimmed glasses.

The second image is a contact sheet of numbered frames from one episode. For every number, say what
the frame shows:
- "A": A alone, or A clearly the only person in focus;
- "B": B alone, or B clearly the only person in focus;
- "AB": both men in the frame;
- "card": an illustrated chapter title card (artwork with a chapter title written over it);
- "other": anything else (a title, a graphic, a blank or dark frame, someone else, a blur).
Also say whether text is overlaid on the picture (a caption, a quote, a logo, a lower third; a
chapter card's own title doesn't count), whether the frame is sharp (not blurred by motion or a
transition), the centre of the main face as x and y percentages of the frame (for AB, the midpoint
between the two faces; for a card, its centre), for AB which man is on the left, and for a card
whether it carries artwork ("art": true for an illustration of people, places or things; false for
a title over a plain, textured or patterned background).

Reply with JSON alone: {"frames": [{"n": 1, "shot": "A", "overlay": false, "sharp": true,
"face": [52, 30], "left": null, "art": null}, ...]}, one entry for every number on the sheet."""

PORTRAIT = """Each numbered picture below was found on Wikimedia Commons as the picture of the
person or subject named beside its number. For each, say:
- "kind": "portrait" (a photograph or painting of one person, face visible), "group" (several
  people), "photo" (a photograph of a place, an event or a thing), "art" (a drawing, a cartoon, a
  poster), "document" (a page, a signature, a map, a chart, a logo) or "other";
- "fits": whether the picture is plausibly what is named, judged only by what can be seen (era,
  setting, the kind of subject); do not try to recognise anyone by their face;
- "text": whether text or a watermark covers part of the picture;
- "face": the centre of the main face (or of the subject) as x and y percentages;
- "caption": a newspaper caption of at most 14 words saying what the picture shows, using only the
  facts given with it (its Commons description and date) and what can be seen. For a portrait,
  the person's name, with the year if the date gives one (“Thomas Sowell in 1964”).

Reply with JSON alone: {"pictures": [{"n": 1, "kind": "portrait", "fits": true, "text": false,
"face": [50, 30], "caption": "Thomas Sowell in 1964"}, ...]}"""


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def clock(sec):
    sec = int(sec)
    return f"{sec // 60}:{sec % 60:02d}"


# ── Claude, looking ──────────────────────────────────────────────────────────────────────────────

def jpeg(im, q=82):
    b = io.BytesIO()
    im.convert("RGB").save(b, "JPEG", quality=q)
    return b.getvalue()


def look(client, images, prompt, log):
    """One call with pictures, its reply read as JSON."""
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b).decode()}}
               for b in images] + [{"type": "text", "text": prompt}]
    for attempt in (1, 2):
        t0 = time.time()
        for wait in [300, 600, 1200, 1800, 1800, None]:   # the subscription's rate limit is waited out, not failed on
            try:
                m = client.messages.create(model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": content}])
                break
            except (anthropic.RateLimitError, anthropic.InternalServerError):
                if wait is None:
                    raise
                log.append({"call": "look", "waited": wait})
                time.sleep(wait)
        text = "".join(b.text for b in m.content if b.type == "text")
        log.append({"call": "look", "seconds": round(time.time() - t0), "in": m.usage.input_tokens, "out": m.usage.output_tokens})
        try:
            return json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError:
            continue
    raise RuntimeError("look: no JSON in the reply")


def sheet(thumbs, cols=4, w=320, h=180):
    """A contact sheet: each thumbnail with its number in a corner, big enough to read."""
    rows = (len(thumbs) + cols - 1) // cols
    out = Image.new("RGB", (cols * w, rows * h), "black")
    d = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = ImageFont.load_default(size=22)
    for i, (n, im) in enumerate(thumbs):
        x, y = (i % cols) * w, (i // cols) * h
        out.paste(im.resize((w, h)), (x, y))
        d.rectangle([x, y, x + 40, y + 28], fill="white")
        d.text((x + 5, y + 2), str(n), fill="black", font=font)
        d.rectangle([x, y, x + w - 1, y + h - 1], outline="white")
    return out


# ── the video ────────────────────────────────────────────────────────────────────────────────────

# what to ask YouTube for, best first: one video's 480p stream answered 503 while its 360p came at once
FORMATS = ["bv*[height<=480][vcodec^=avc1]", "bv*[height<=360][vcodec^=avc1]", "bv*[height<=480]", "bv*[height<=360]", "18"]


def seconds(path):
    """How long a video file plays, as ffprobe reads it; 0 if it can't."""
    r = subprocess.run([shutil.which("ffprobe") or FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def download(n, video_id, expect=None):
    path = os.path.join(WORK, f"{n:03d}-480.mp4")
    if os.path.exists(path):
        return path
    tried = []
    for f in FORMATS:
        r = subprocess.run([YTDLP, "-q", "--no-warnings", "--sleep-requests", "1.5", "-f", f, "--remux-video", "mp4", "-o", path,
                            f"https://www.youtube.com/watch?v={video_id}"], capture_output=True, text=True)
        # a file that came whole: one cut short (Episode 14's) had no frame at thirty seconds
        if r.returncode == 0 and os.path.exists(path) and (not expect or seconds(path) >= 0.9 * expect):
            return path
        if r.returncode == 0 and os.path.exists(path):
            r.stderr = f"came short: {seconds(path):.0f} of {expect} s"
        tried.append(f"{f}: {(r.stderr.strip().splitlines() or [str(r.returncode)])[-1][:160]}")
        for left in os.listdir(WORK):   # a failed try leaves its .part behind
            if left.startswith(f"{n:03d}-480"):
                os.remove(os.path.join(WORK, left))
    raise RuntimeError("download failed: " + " | ".join(tried))


class Source:
    """The episode's video, as frames and clips. The whole file when YouTube serves it; when it won't
    (one video answered 503, or cut off after 261 bytes, to every whole download, yet served a
    section at once), short clips fetched at just the times asked for, nearby times sharing one."""

    def __init__(self, n, video_id, expect=None):
        self.n, self.url, self.clips, self.why = n, f"https://www.youtube.com/watch?v={video_id}", [], None
        try:
            self.whole = download(n, video_id, expect)
        except RuntimeError as e:
            self.whole, self.why = None, str(e)[:300]

    def fetch(self, times, length=4.8):
        if self.whole:
            return
        windows = []
        for t in sorted(t for t in set(times) if not self.covered(t)):
            if windows and t <= windows[-1][1] - length + 2.5:   # close enough to stretch the last clip
                windows[-1][1] = t + length
            else:
                windows.append([max(0.0, t), t + length])
        for i in range(0, len(windows), 30):
            batch = windows[i:i + 30]
            args = [YTDLP, "-q", "--no-warnings", "--sleep-requests", "1.5", "--sleep-interval", "2", "-f", "bv*[height<=360][vcodec^=avc1]/bv*[height<=360]/18", "--force-keyframes-at-cuts",
                    "-o", os.path.join(WORK, f"{self.n:03d}-clip-%(section_start)s.%(ext)s")]
            for a, b in batch:
                args += ["--download-sections", f"*{a:.2f}-{b:.2f}"]
            subprocess.run(args + [self.url], capture_output=True, text=True)
            for name in os.listdir(WORK):
                m = re.fullmatch(rf"{self.n:03d}-clip-([\d.]+)\.mp4", name)
                if not m:
                    continue
                a = float(m.group(1))
                for w0, w1 in batch:
                    if abs(w0 - a) < 0.05 and not any(abs(c[0] - w0) < 0.05 for c in self.clips):
                        path = os.path.join(WORK, name)
                        if os.path.getsize(path) < 20000:   # a refused fetch leaves a stub of a few hundred bytes
                            os.remove(path)
                            continue
                        self.clips.append((w0, w1, path))

    def covered(self, t, need=0.3):
        return any(a <= t <= b - need for a, b, _ in self.clips)

    def at(self, t, need=0.3):
        """(file, offset) for the frame at t seconds."""
        if self.whole:
            return self.whole, t
        if not self.covered(t, need):
            self.fetch([t])
        for a, b, f in self.clips:
            if a <= t <= b - need:
                return f, t - a
        raise RuntimeError(f"no clip of the video at {t:.1f} s ({self.why})")

    def close(self):
        for f in [self.whole] + [c[2] for c in self.clips]:
            if f and os.path.exists(f):
                os.remove(f)


def frame(src, t, width=320):
    """The frame at t seconds, as a Pillow image; None if it can't be had."""
    try:
        video, t = src.at(t)
        r = subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                            "-vf", f"scale={width}:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "-"],
                           check=True, capture_output=True)
        return Image.open(io.BytesIO(r.stdout))
    except (RuntimeError, subprocess.CalledProcessError, OSError):
        return None


def holds(src, t, seconds=4.0):
    """Whether the camera holds from t for `seconds`: no cut and no dissolve inside the loop."""
    try:
        video, t = src.at(t, need=seconds)
    except RuntimeError:
        return False
    r = subprocess.run([FFMPEG, "-nostdin", "-hide_banner", "-ss", f"{t:.2f}", "-t", f"{seconds}", "-i", video,
                        "-vf", "select='gt(scene,0.18)',metadata=print", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    return "lavfi.scene_score" not in r.stderr


def loop(src, t, out):
    """A 4 s silent loop from t, small enough for a column, and its first frame as the poster."""
    video, t = src.at(t, need=4.0)
    run(FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-t", "4", "-i", video, "-an",
        "-vf", "scale=640:-2,fps=25", "-c:v", "libx264", "-threads", "2", "-preset", "slow", "-crf", "29", "-profile:v", "main",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out + ".mp4")
    run(FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
        "-vf", "scale=640:-2", "-q:v", "4", out + ".jpg")


def pair(src, left, right, out):
    """Two close-ups side by side, each cut to 8:9 around its face: for an episode whose camera never
    holds both hosts in one frame. `left` and `right` are (t, face x in per cent)."""
    (lv, lt), (rv, rt) = src.at(left[0], need=4.0), src.at(right[0], need=4.0)
    left, right = (lt, left[1]), (rt, right[1])
    crop = lambda fx: f"crop=w=ih*8/9:h=ih:x='min(max(iw*{fx / 100:.3f}-ih*4/9,0),iw-ih*8/9)':y=0,scale=320:360,setsar=1"
    run(FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-ss", f"{left[0]:.2f}", "-t", "4", "-i", lv, "-ss", f"{right[0]:.2f}", "-t", "4", "-i", rv,
        "-filter_complex", f"[0:v]{crop(left[1])}[l];[1:v]{crop(right[1])}[r];[l][r]hstack,fps=25[v]", "-map", "[v]", "-an",
        "-c:v", "libx264", "-threads", "2", "-preset", "slow", "-crf", "29", "-profile:v", "main", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out + ".mp4")
    run(FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-i", out + ".mp4", "-frames:v", "1", "-q:v", "4", out + ".jpg")


def still(src, t, out, width=854):
    video, t = src.at(t)
    run(FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
        "-vf", f"scale={width}:-2", "-q:v", "3", out)


# ── where to look in the video ───────────────────────────────────────────────────────────────────

def runs(t, spk, a, b, least=5.0):
    """Stretches inside [a, b] seconds where speaker `spk` talks for at least `least` seconds."""
    out, cur = [], None
    for w0, w1, _, s in t.words:
        if w1 < a or w0 > b:
            continue
        if s == spk and (cur is None or w0 - cur[1] < 1.5):
            cur = [cur[0] if cur else w0, w1]
        else:
            if cur and cur[1] - cur[0] >= least:
                out.append(cur)
            cur = [w0, w1] if s == spk else None
    if cur and cur[1] - cur[0] >= least:
        out.append(cur)
    return out


def speaker_times(t, spk, a, b, near, k=8):
    """Up to k moments where `spk` is speaking and has a few seconds left, nearest `near` first."""
    times = []
    for r0, r1 in runs(t, spk, a, b):
        x = r0 + 1.0
        while x + 4.5 <= r1:
            times.append(x)
            x += 6.0
    times.sort(key=lambda x: abs(x - near))
    picked = []
    for x in times:
        if all(abs(x - y) >= 5 for y in picked):
            picked.append(x)
        if len(picked) == k:
            break
    return picked


# ── Wikimedia Commons ────────────────────────────────────────────────────────────────────────────

def api(url, params):
    time.sleep(1.0)   # Wikimedia asks for gentleness; fast loops get HTTP 429
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode({**params, 'format': 'json'})}", headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("Wikimedia keeps saying 429")


def plain(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s or ""))).strip()


STOP = set("the a an of and in on at for to from with by his her their its who was is".split())


def find(name, hint, person):
    """Wikidata's image of `name`: the first search hit whose description shares a word with the
    hint (and is a human, for a person), with its Commons file's author, licence and description."""
    hits = api("https://www.wikidata.org/w/api.php", {"action": "wbsearchentities", "search": name, "language": "en", "type": "item", "limit": 6})
    want = {w for w in re.findall(r"[a-z]+", hint.lower()) if w not in STOP and len(w) > 2}
    for hit in hits.get("search", []):
        desc = hit.get("description", "")
        if want and not want & set(re.findall(r"[a-z]+", desc.lower())):
            continue
        ent = api("https://www.wikidata.org/w/api.php", {"action": "wbgetentities", "ids": hit["id"], "props": "claims"})["entities"][hit["id"]]
        claims = ent.get("claims", {})
        if person and not any(c["mainsnak"].get("datavalue", {}).get("value", {}).get("id") == "Q5" for c in claims.get("P31", [])):
            continue
        img = next((c["mainsnak"]["datavalue"]["value"] for c in claims.get("P18", []) if "datavalue" in c["mainsnak"]), None)
        if not img:
            return None
        info = api("https://commons.wikimedia.org/w/api.php", {"action": "query", "titles": f"File:{img}", "prop": "imageinfo",
                                                                "iiprop": "url|size|extmetadata", "iiurlwidth": 800})
        page = next(iter(info["query"]["pages"].values()))
        ii = page["imageinfo"][0]
        meta = ii.get("extmetadata", {})
        get = lambda k: plain(meta.get(k, {}).get("value", ""))
        return {"qid": hit["id"], "label": hit.get("label", name), "description": desc, "file": img, "url": ii.get("thumburl") or ii["url"],
                "artist": get("Artist"), "license": get("LicenseShortName"), "about": get("ImageDescription")[:400],
                "date": get("DateTimeOriginal")[:40]}
    return None


def fetch(url):
    time.sleep(1.0)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return Image.open(io.BytesIO(r.read()))


def credit(found):
    who = re.sub(r"^(cr[ée]dit(s)?( photo)?|photo( by)?|photograph( by)?|author|by)\s*:?\s*", "", found["artist"], flags=re.I).strip()
    if not who or len(who) > 60 or re.search(r"unknown|anonymous", who, re.I):
        who = "Wikimedia Commons"
    lic = found["license"] or "free licence"
    return f"{who}, {'public domain' if lic.lower().startswith(('public domain', 'pd')) else lic}"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40]


# ── an edition's pictures ────────────────────────────────────────────────────────────────────────

def pictures(client, n, archive):
    began = time.time()
    log = []
    d = os.path.join(EDITIONS, f"{n:03d}")
    copy = C.normalize(json.load(open(os.path.join(d, "copy.json"), encoding="utf-8")))
    meta = json.load(open(os.path.join(ROOT, "data", "original", "metadata", f"{n:03d}.json"), encoding="utf-8"))
    notes = open(os.path.join(ROOT, "data", "original", "descriptions", f"{n:03d}.txt"), encoding="utf-8").read()
    simahina = bool(re.search(r"by Simahina", notes, re.I))
    t = build.transcript(n)
    ep = archive.episode(n)
    items = {i["id"]: i for i in ep["items"]}
    dur = meta["duration_seconds"]
    chapters = meta["chapters"]
    out = os.path.join(d, "media")
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    # 1. the photographs the copy asks for, from Commons
    wanted = []   # (key, name, hint, person)
    if copy.get("skylinePhoto"):
        wanted.append(("skyline", copy["skylinePhoto"]["person"], copy["skylinePhoto"]["hint"], True))
    if copy["p2"]["side"].get("photo"):
        wanted.append(("side", copy["p2"]["side"]["photo"]["person"], copy["p2"]["side"]["photo"]["hint"], True))
    if copy["second"].get("photo"):
        wanted.append(("second", copy["second"]["photo"]["subject"], copy["second"]["photo"]["hint"], False))
    for s in copy["p2"]["sections"]:
        for p in s["portraits"]:
            wanted.append((f"portrait:{s['id']}", p["person"], p["hint"], True))
    for p in copy["shelf"]["portraits"]:
        wanted.append(("shelf", p["person"], p["hint"], True))
    found = {}
    for key, name, hint, person in wanted:
        if name in found:
            continue
        try:
            f = find(name, hint, person)
        except Exception as e:  # Commons is a nicety, never a reason to fail an edition
            log.append({"commons": name, "error": str(e)[:200]})
            f = None
        if f:
            try:
                f["image"] = fetch(f["url"])
            except Exception as e:
                log.append({"commons": name, "error": f"fetch: {str(e)[:200]}"})
                f = None
        found[name] = f
        log.append({"commons": name, "found": bool(f), **({k: f[k] for k in ("qid", "description", "file", "license", "artist")} if f else {})})
    got = [(name, f) for name, f in found.items() if f]
    verdicts = {}
    for i in range(0, len(got), 8):
        batch = got[i:i + 8]
        labels = "\n".join(f"{k + 1}: {name} ({f['description']}). Commons describes it: “{f['about'] or 'no description'}”; date: {f['date'] or 'none given'}"
                           for k, (name, f) in enumerate(batch))
        thumbs = [jpeg(f["image"].copy().resize((int(f["image"].width * 360 / f["image"].height), 360)) if f["image"].height > 360 else f["image"]) for _, f in batch]
        prompt = PORTRAIT + "\n\nThe pictures, in order:\n" + labels
        v = look(client, thumbs, prompt, log)
        for k, (name, f) in enumerate(batch):
            verdicts[name] = next((x for x in v.get("pictures", []) if x.get("n") == k + 1), {})
    photos = {}
    for name, f in got:
        v = verdicts.get(name, {})
        person = any(w[1] == name and w[3] for w in wanted)
        ok = v.get("fits") and not v.get("text") and (v.get("kind") == "portrait" if person else v.get("kind") in ("photo", "portrait", "group", "art"))
        log.append({"commons": name, "verdict": v, "used": bool(ok)})
        if not ok:
            continue
        im = f["image"].convert("RGB")
        if im.width > 800:
            im = im.resize((800, round(im.height * 800 / im.width)))
        fn = f"photo-{slug(name)}.jpg"
        im.save(os.path.join(out, fn), quality=82, optimize=True)
        face = v.get("face") or [50, 30]
        nat = im.height / im.width
        photos[name] = {"src": fn, "credit": credit(f), "focus": f"{face[0]}% {face[1]}%", "nat": round(nat, 4), "caption": v.get("caption") or name,
                        "about": f["about"], "date": f["date"], "label": f["label"], "commons": f"{f['file']} ({f['license']})"}

    # 2. the video: candidates for every slot, read off contact sheets
    video = Source(n, meta["video_id"], meta["duration_seconds"])
    slots = {}   # key -> {"want": "AB"|"A"|"B"|"card", "times": [...], ...}

    def speaker_slot(key, iid, near=None, window=None, who=None):
        it = items.get(iid)
        if not it or "at" not in it:
            return
        spk = who if who is not None else it["spk"]
        if spk not in (0, 1):
            return
        a, b = window or (it["clip"][0] / 100 - 30, it["clip"][1] / 100 + 30)
        near = near or it["at"][0] / 100
        # the speaker in the moment's own minute if possible, else anywhere in the episode
        times = speaker_times(t, spk, max(0, a), min(dur - 5, b), near) or speaker_times(t, spk, 0, dur - 5, near)
        if times:
            slots[key] = {"want": LOOK[spk], "speaker": HOSTS[spk], "times": times}

    # the two hosts together: early on first, then anywhere
    early = [float(x) for x in range(15, int(min(420, dur - 10)), 15)][:24]
    slots["lead"] = {"want": "AB", "times": early + [float(x) for x in range(480, int(dur - 10), max(60, int(dur / 14)))][:12]}
    sp = copy["second"].get("photo")
    if not (sp and sp["subject"] in photos):
        speaker_slot("second", copy["second"]["item"])
    speaker_slot("third", copy["third"]["item"])
    for s in copy["p3"]["stories"]:
        it = items.get(s["item"], {})
        a, b = t.locate(s["start"]), t.locate(s["end"])
        window = (t.words[a[0]][0], t.words[b[1]][1]) if a and b and b[1] > a[0] else None
        teller = HOSTS.index(it["teller"]) if it.get("teller") in HOSTS else it.get("spk")
        speaker_slot(f"story:{s['id']}", s["item"], window=window, who=teller)
    for s in copy["p2"]["sections"]:
        if s["chapter"] is not None and 0 <= s["chapter"] < len(chapters):
            c0 = chapters[s["chapter"]]["start"]
            c1 = chapters[s["chapter"] + 1]["start"] if s["chapter"] + 1 < len(chapters) else dur
            slots[f"card:{s['id']}"] = {"want": "card", "times": [c0 + x for x in (0.6, 1.5, 2.5, 3.5, 5.0)]}
            # if the card is plain, the chapter's main voice, within the chapter
            talk = [0.0, 0.0, 0.0]
            for w0, w1, _, k in t.words:
                if c0 <= w0 < c1:
                    talk[k] += w1 - w0
            speaker_slot(f"still:{s['id']}", s["quote"]["item"], window=(c0 + 8, c1 - 2), who=0 if talk[0] >= talk[1] else 1)
        else:
            speaker_slot(f"still:{s['id']}", s["quote"]["item"])
    speaker_slot("side-still", copy["p2"]["sections"][0]["quote"]["item"])

    cands = [(key, x) for key, s in slots.items() for x in s["times"]]
    video.fetch([x for _, x in cands])   # a whole video needs nothing; clips come in a few calls
    if video.why:
        log.append({"source": "clips", "why": video.why, "clips": len(video.clips)})
    frames = {}

    def classify(cands):
        for i in range(0, len(cands), 24):
            batch = [(key, x, frame(video, x)) for key, x in cands[i:i + 24]]
            batch = [b for b in batch if b[2] is not None]   # frames that couldn't be had are left out
            if not batch:
                continue
            thumbs = [(k + 1, im) for k, (_, _, im) in enumerate(batch)]
            ref = open(os.path.join(WORK, "hosts-ref.jpg"), "rb").read()
            v = look(client, [ref, jpeg(sheet(thumbs))], CLASSIFY, log)
            for k, (key, x, _) in enumerate(batch):
                frames[(key, x)] = next((f for f in v.get("frames", []) if f.get("n") == k + 1), {})
    classify(cands)

    # a second chance for a speaker slot with nothing usable near its moment (every frame a graphic, a
    # blur or the other host): the same speaker, anywhere in the episode
    usable = lambda key: any((f := frames.get((key, x), {})).get("shot") in (slots[key]["want"], "AB") and not f.get("overlay")
                             for x in slots[key]["times"])
    again = []
    for key, sl in slots.items():
        if sl["want"] in ("A", "B") and not usable(key):
            spk = 1 if sl["want"] == "A" else 0
            more = [x for x in speaker_times(t, spk, 0, dur - 5, sl["times"][0] if sl["times"] else dur / 2, k=10) if x not in sl["times"]]
            sl["times"] += more
            again += [(key, x) for x in more]
    if again:
        log.append({"second_chance": sorted({k for k, _ in again})})
        video.fetch([x for _, x in again])
        classify(again)

    taken = set()   # no frame twice in one edition

    def pick(key, moving=True, need=None, want=None):
        s = slots.get(key)
        if not s:
            return None
        for x in s["times"]:
            f = frames.get((key, x), {})
            if x in taken or f.get("shot") != (want or s["want"]) or f.get("overlay") or f.get("sharp") is False or (need and not f.get(need)):
                continue
            if moving and not holds(video, x):
                continue
            face = f.get("face") or [50, 35]
            taken.add(x)
            return {"t": x, "focus": f"{face[0]}% {face[1]}%", "left": f.get("left"), "x": face[0]}
        return None

    media, made = {}, []

    def speaker(key, moving=True, pair_first=False):
        """The speaker in close-up; failing that, both hosts in one frame (early episodes held a wide
        shot for whole chapters), with the caption saying which side the speaker sits. `pair_first`
        asks for the two-shot first, for variety where one voice carries a whole page."""
        close = (lambda: pick(key, moving=moving))
        if not pair_first and (p := close()):
            return p, ""
        p = pick(key, moving=moving, want="AB")
        if not p and pair_first:
            p = close()
            if p:
                return p, ""
        if not p:
            # last, the same speaker from another moment of the episode (Episode 9's video served only
            # some of the clips asked for): the caption then names the episode, not the moment
            want = slots[key]["want"]
            for (k2, x), f in sorted(frames.items(), key=lambda kv: kv[0][1]):
                if x in taken or f.get("shot") != want or f.get("overlay") or f.get("sharp") is False or (moving and not holds(video, x)):
                    continue
                taken.add(x)
                face = f.get("face") or [50, 35]
                return {"t": x, "focus": f"{face[0]}% {face[1]}%", "left": None, "x": face[0]}, "borrowed"
            return None, ""
        who = slots[key]["speaker"]
        side = "" if p["left"] not in ("A", "B") else (   # unsure who sits where: say neither
            ("left" if p["left"] == "A" else "right") if who == HOSTS[1] else ("right" if p["left"] == "A" else "left"))
        other = HOSTS[0] if who == HOSTS[1] else HOSTS[1]
        return p, f"|{side}|{other}"

    def says(name, topic, how):
        """'Ajay Shah on the soil', or, from a two-shot, 'Ajay Shah (left) on the soil, with Amit Varma'."""
        if how == "borrowed":   # a frame from elsewhere in the episode claims no moment
            return f"{name} in Episode {n}"
        if not how:
            return f"{name} on {topic}" if topic else name
        _, side, other = how.split("|")
        name = f"{name} ({side})" if side else name
        return f"{name} on {topic}, with {other}" if topic else f"{name} with {other}"

    def moving(key, name, topic):
        for _ in range(3):   # a clip that fails to cut is struck off, and the next candidate tried
            p, how = speaker(key)
            if not p:
                return None
            try:
                loop(video, p["t"], os.path.join(out, name))
                break
            except (RuntimeError, subprocess.CalledProcessError):
                frames[(key, p["t"])] = {}
        else:
            return None
        made.append((key, p["t"]))
        return {"video": f"{name}.mp4", "poster": f"{name}.jpg", "caption": says(slots[key]["speaker"], topic, how), "focus": p["focus"], "t": p["t"]}

    # the lead: both hosts, near the start; or, where the camera never holds both, one of each
    p = pick("lead")
    if not p:
        ajay, amit = pick("lead", want="A"), pick("lead", want="B")
        if ajay and amit:
            pair(video, (ajay["t"], ajay["x"]), (amit["t"], amit["x"]), os.path.join(out, "lead"))
            when = "early in" if max(ajay["t"], amit["t"]) < 480 else "in"
            media["lead"] = {"video": "lead.mp4", "poster": "lead.jpg", "caption": f"Ajay Shah (left) and Amit Varma {when} Episode {n}",
                             "focus": "50% 35%", "t": ajay["t"], "pair": True}
            im = Image.open(os.path.join(out, "lead.jpg")).convert("RGB")
            im.thumbnail((400, 225))
            im.save(os.path.join(out, "thumb.jpg"), quality=74, optimize=True)
    if p:
        loop(video, p["t"], os.path.join(out, "lead"))
        left, right = (HOSTS[1], HOSTS[0]) if p["left"] == "A" else (HOSTS[0], HOSTS[1])
        when = "early in" if p["t"] < 480 else "in"   # the second chance looks across the whole episode
        media["lead"] = {"video": "lead.mp4", "poster": "lead.jpg", "caption": f"{left} (left) and {right} {when} Episode {n}",
                         "focus": p["focus"], "t": p["t"]}
        im = Image.open(os.path.join(out, "lead.jpg")).convert("RGB")   # the archive's thumbnail
        im.thumbnail((400, 225))
        im.save(os.path.join(out, "thumb.jpg"), quality=74, optimize=True)
    # the second story: its photograph, else its speaker
    sp = copy["second"].get("photo")
    if sp and sp["subject"] in photos:
        ph = photos[sp["subject"]]
        media["second"] = {"src": ph["src"], "caption": ph["caption"], "credit": ph["credit"], "focus": ph["focus"],
                           "ratio": [round(ph["nat"] * 0.75, 3), ph["nat"], round(min(max(ph["nat"] * 1.6, 1.4), 2.0), 3)], "about": ph["about"], "date": ph["date"]}
    else:
        media["second"] = moving("second", "second", copy["second"]["caption"]) if "second" in slots else None
    media["third"] = moving("third", "third", copy["third"]["caption"]) if "third" in slots else None
    media["stories"] = {}
    for s in copy["p3"]["stories"]:
        key = f"story:{s['id']}"
        media["stories"][s["id"]] = moving(key, f"story-{s['id']}", s["caption"]) if key in slots else None
    # the opinion page: chapter cards where they carry art (a plain title card was a black box with
    # words in it), else whoever carried the chapter
    media["sections"] = {}
    for i, s in enumerate(copy["p2"]["sections"]):
        p = pick(f"card:{s['id']}", moving=False, need="art")
        if p:
            fn = f"ch{s['chapter']}.jpg"
            still(video, p["t"], os.path.join(out, fn))
            media["sections"][s["id"]] = {"src": fn, "credit": "Art: Simahina" if simahina else None, "card": True}
            continue
        key = f"still:{s['id']}"
        p, how = speaker(key, moving=False, pair_first=i % 2 == 1) if key in slots else (None, "")
        if p:
            fn = f"still-{s['id']}.jpg"
            still(video, p["t"], os.path.join(out, fn))
            media["sections"][s["id"]] = {"src": fn, "caption": says(slots[key]["speaker"], s.get("caption"), how),
                                          "focus": p["focus"], "ratio": [0.42, 0.5625, 0.74]}
            continue
        # last, the plain title card: in a chapter shown all in graphics (Episode 118's), it was the one
        # clean frame, and a section without a picture can't be fitted
        p = pick(f"card:{s['id']}", moving=False)
        if p:
            fn = f"ch{s['chapter']}.jpg"
            still(video, p["t"], os.path.join(out, fn))
            media["sections"][s["id"]] = {"src": fn, "credit": "Art: Simahina" if simahina else None, "card": True}
    # beside the first section: the person the copy names, else the speaker of its quote
    side = copy["p2"]["side"].get("photo")
    if side and side["person"] in photos:
        ph = photos[side["person"]]
        media["side"] = {"src": ph["src"], "caption": ph["caption"], "credit": ph["credit"], "focus": ph["focus"],
                         "ratio": [round(ph["nat"] * 0.72, 3), ph["nat"], round(min(ph["nat"] * 1.36, 1.9), 3)]}
    else:
        p, how = speaker("side-still", moving=False) if "side-still" in slots else (None, "")
        if p:
            still(video, p["t"], os.path.join(out, "side.jpg"), width=640)
            media["side"] = {"src": "side.jpg", "caption": says(slots["side-still"]["speaker"], None, how), "focus": p["focus"], "ratio": [0.9, 1.25, 1.7]}
    # the skyline's photograph: the person the copy names, else a picture from the story it teases
    sk = copy.get("skylinePhoto")
    if sk and sk["person"] in photos:
        media["skyline"] = {"src": photos[sk["person"]]["src"], "who": sk["person"], "focus": photos[sk["person"]]["focus"]}
    else:
        to = copy["skyline"][2]["to"]
        alt = (media["stories"].get(to) or media["sections"].get(to) or media.get("lead")) or {}
        src = alt.get("poster") or alt.get("src")
        who = alt.get("caption", "").split(" on ")[0] if alt.get("poster") else ("Art: Simahina" if alt.get("card") and simahina else "")
        if src:
            media["skyline"] = {"src": src, "who": who or "Everything is Everything", "focus": alt.get("focus", "50% 40%")}
    media["portraits"] = {}
    for s in copy["p2"]["sections"]:
        ps = [{"src": photos[p["person"]]["src"], "caption": p["person"], "credit": photos[p["person"]]["credit"]} for p in s["portraits"] if p["person"] in photos]
        if ps:
            media["portraits"][s["id"]] = ps
    media["shelf"] = [{"src": photos[p["person"]]["src"], "caption": p["person"], "credit": photos[p["person"]]["credit"]}
                      for p in copy["shelf"]["portraits"] if p["person"] in photos]
    used = {m.get("src") for m in [media.get("second") or {}, media.get("side") or {}, media.get("skyline") or {}]}
    used |= {p["src"] for ps in media["portraits"].values() for p in ps} | {p["src"] for p in media["shelf"]}
    media["credits"] = [f"{ph['label']} ({ph['credit']})" for name, ph in photos.items() if ph["src"] in used]
    for fn in os.listdir(out):   # photographs found but not used
        if fn.startswith("photo-") and fn not in used:
            os.remove(os.path.join(out, fn))
    media["log"] = {"seconds": round(time.time() - began), "made": made}
    # every picture a page leans on to fit: an empty slot leaves a story with nothing to give
    missing = ([k for k in ("lead", "second", "third", "side") if not media.get(k)]
               + [f"story:{k}" for k, v in media["stories"].items() if not v]
               + [f"section:{x['id']}" for x in copy["p2"]["sections"] if x["id"] not in media["sections"]])
    with open(os.path.join(d, "media.json"), "w", encoding="utf-8") as f:
        json.dump(media, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.makedirs(LOGS, exist_ok=True)
    with open(os.path.join(LOGS, f"{n:03d}.json"), "w", encoding="utf-8") as f:
        json.dump({"episode": n, "calls": log, "slots": {k: {**v, "times": v["times"]} for k, v in slots.items()},
                   "frames": {f"{k}@{x}": v for (k, x), v in frames.items()}}, f, ensure_ascii=False, indent=1)
    video.close()
    build._transcripts.pop(n, None)
    size = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    return {"episode": n, "seconds": round(time.time() - began), "files": len(os.listdir(out)), "kb": size // 1024,
            "photos": len(photos), "missing": missing}


def main(args):
    every = "--all" in args
    reverse = "--reverse" in args
    episodes = [int(a) for a in args if a.isdigit()] or (range(1, 129) if every else [])
    failed = os.path.join(ROOT, "work", "editions", "media-failed")
    os.makedirs(failed, exist_ok=True)
    # an episode whose video YouTube refused is left alone for six hours, not asked again every pass
    resting = lambda n: os.path.exists(os.path.join(failed, f"{n:03d}")) and time.time() - os.path.getmtime(os.path.join(failed, f"{n:03d}")) < 6 * 3600
    todo = [n for n in episodes if os.path.exists(os.path.join(EDITIONS, f"{n:03d}", "copy.json"))
            and (not every or not os.path.exists(os.path.join(EDITIONS, f"{n:03d}", "media.json")) and not resting(n))]
    todo = todo[::-1] if reverse else todo
    assert FFMPEG and YTDLP, "ffmpeg and yt-dlp must be on PATH"
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(ROOT, "work", ".auth2api-key")) as f:
        client = anthropic.Anthropic(base_url=GATEWAY, api_key=f.read().strip(), max_retries=4, timeout=600)
    archive = BP.Archive()
    for n in todo:   # one at a time in this process: the downloads are big and YouTube is better asked gently
        d = os.path.join(EDITIONS, f"{n:03d}")
        if every and os.path.exists(os.path.join(d, "media.json")):
            continue   # another loop got there first
        claim = os.path.join(d, ".picturing")   # two loops share the list; an episode is claimed first
        try:
            os.close(os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            continue
        try:
            time.sleep(60)   # a minute between episodes: YouTube had begun asking this IP to prove it's not a bot
            print(json.dumps(pictures(client, n, archive), ensure_ascii=False), flush=True)
        except Exception as e:  # one bad episode shouldn't stop the run
            print(json.dumps({"episode": n, "error": f"{type(e).__name__}: {e}"}), flush=True)
            with open(os.path.join(failed, f"{n:03d}"), "w") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M')} {type(e).__name__}: {e}\n")
            for left in os.listdir(WORK):   # whatever it fetched before failing
                if left.startswith(f"{n:03d}-"):
                    os.remove(os.path.join(WORK, left))
        finally:
            os.remove(claim)


if __name__ == "__main__":
    main(sys.argv[1:])
