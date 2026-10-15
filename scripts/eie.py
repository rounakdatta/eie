#!/usr/bin/env python3
"""Data pipeline for the Everything is Everything archive.

  python3 scripts/eie.py metadata [dir]  # refresh data/original/metadata + descriptions from YouTube (needs yt-dlp),
                                         # or from a dir of yt-dlp .info.json files already fetched
  python3 scripts/eie.py flatten         # write ID-tagged JSONL of every insight to work/ (input for the analysis)
  python3 scripts/eie.py build           # write data/generated/episodes.json and check the analysis files

Every insight has a stable ID: episode, kind, position. 045-S03 is the third story of episode 45
(S stories, R recommendations, C core ideas, J jokes and references). The cross-episode files
in data/generated/analysis cite these IDs, and `build` fails if one does not resolve.
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
INSIGHTS = os.path.join(DATA, "generated", "insights")
ANALYSIS = os.path.join(DATA, "generated", "analysis")
METADATA = os.path.join(DATA, "original", "metadata")
DESCRIPTIONS = os.path.join(DATA, "original", "descriptions")
WORK = os.path.join(ROOT, "work")
CHANNEL = "https://www.youtube.com/@amitvarma/videos"
KINDS = {"S": "stories", "R": "recommendations", "C": "core_ideas", "J": "jokes_and_cultural_references"}
VIDEO_ID = re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/live/)([A-Za-z0-9_-]{11})")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def episodes():
    return [load(p) for p in sorted(glob.glob(os.path.join(INSIGHTS, "*.json")))]


def insight_index():
    """Every insight keyed by its ID."""
    index = {}
    for ep in episodes():
        for kind, field in KINDS.items():
            for i, item in enumerate(ep[field], 1):
                index[f"{ep['episode_number']:03d}-{kind}{i:02d}"] = item
    return index


def episode_number(title):
    return int(re.search(r"\b(?:Episode|Ep)\s*(\d+)", title).group(1))


def cmd_metadata(info_dir=None):
    """Keep the useful fields of each episode's YouTube metadata, and its description verbatim.

    Fetches the info JSONs with yt-dlp unless given a directory that already holds them.
    """
    if not info_dir:
        info_dir = os.path.join(WORK, "youtube")
        subprocess.run(["yt-dlp", "--skip-download", "--write-info-json", "--no-write-playlist-metafiles",
                        "--sleep-requests", "1", "--sleep-interval", "2", "--max-sleep-interval", "4",
                        "-o", os.path.join(info_dir, "%(id)s.%(ext)s"), CHANNEL], check=True)
    os.makedirs(METADATA, exist_ok=True)
    fetched = datetime.date.today().isoformat()
    for path in sorted(glob.glob(os.path.join(info_dir, "*.info.json"))):
        info = load(path)
        n = episode_number(info["title"])
        dump({
            "episode_number": n,
            "video_id": info["id"],
            "url": f"https://www.youtube.com/watch?v={info['id']}",
            "title": info["title"],
            "release_date": datetime.datetime.strptime(info["upload_date"], "%Y%m%d").date().isoformat(),
            "duration_seconds": info["duration"],
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "comment_count": info.get("comment_count"),
            "chapters": [{"start": c["start_time"], "title": c["title"]} for c in info.get("chapters") or []],
            "fetched": fetched,
        }, os.path.join(METADATA, f"{n:03d}.json"))
        with open(os.path.join(DESCRIPTIONS, f"{n:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(info["description"] + "\n")


def write_jsonl(rows, path):
    """Write atomically: the analysis may be reading the previous version."""
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.writelines(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
    os.replace(path + ".tmp", path)


def cmd_flatten():
    """One JSONL file per insight kind, each line carrying its ID and episode, plus an episode digest."""
    os.makedirs(WORK, exist_ok=True)
    cites = citations()
    linked_from = {}
    for n, linked in cites.items():
        for m in linked:
            linked_from.setdefault(m, []).append(n)
    digest = []
    for ep in episodes():
        n = ep["episode_number"]
        meta = load(os.path.join(METADATA, f"{n:03d}.json"))
        with open(os.path.join(DESCRIPTIONS, f"{n:03d}.txt"), encoding="utf-8") as d:
            blurb = re.split(r"TABLE OF CONTENTS|(?:OTHER )?USEFUL RESOURCES|ESSENTIAL READING", d.read())[0].strip()
        digest.append({"episode": n, "title": ep["episode_title"], "release_date": meta["release_date"],
                       "chapters": [c["title"] for c in meta["chapters"]], "blurb": blurb,
                       "core_ideas": [c["concept"] for c in ep["core_ideas"]],
                       "links_to": cites[n], "linked_from": sorted(linked_from.get(n, []))})
    write_jsonl(digest, os.path.join(WORK, "episodes.jsonl"))
    for kind, field in KINDS.items():
        write_jsonl(({"id": f"{ep['episode_number']:03d}-{kind}{i:02d}", "episode": ep["episode_number"], **item}
                     for ep in episodes() for i, item in enumerate(ep[field], 1)),
                    os.path.join(WORK, f"{field}.jsonl"))
    print(f"wrote {WORK}", file=sys.stderr)


def citations():
    """Which episodes each episode's show notes link to, from the YouTube links in its description."""
    meta = {m["video_id"]: m["episode_number"] for m in map(load, glob.glob(os.path.join(METADATA, "*.json")))}
    cites = {}
    for path in sorted(glob.glob(os.path.join(DESCRIPTIONS, "*.txt"))):
        n = int(os.path.basename(path)[:3])
        with open(path, encoding="utf-8") as f:
            linked = {meta[v] for v in VIDEO_ID.findall(f.read()) if v in meta}
        cites[n] = sorted(linked - {n})
    return cites


def check_ids(obj, index, where, problems):
    """Every string that looks like an insight ID must name a real insight."""
    if isinstance(obj, dict):
        for v in obj.values():
            check_ids(v, index, where, problems)
    elif isinstance(obj, list):
        for v in obj:
            check_ids(v, index, where, problems)
    elif isinstance(obj, str) and re.fullmatch(r"\d{3}-[SRCJ]\d{2}", obj) and obj not in index:
        problems.append(f"{where}: unknown insight {obj}")


def cmd_build():
    index = insight_index()
    problems = []
    analysis = {}
    for path in sorted(glob.glob(os.path.join(ANALYSIS, "*.json"))):
        analysis[os.path.basename(path)] = data = load(path)
        check_ids(data, index, os.path.basename(path), problems)

    threads = {}
    for t in analysis.get("threads.json", {}).get("threads", []):
        for step in t["path"]:
            threads.setdefault(step["episode"], []).append(t["id"])

    cites = citations()
    cited_by = {}
    for n, linked in cites.items():
        for m in linked:
            cited_by.setdefault(m, []).append(n)

    rows = []
    for ep in episodes():
        n = ep["episode_number"]
        meta = load(os.path.join(METADATA, f"{n:03d}.json"))
        for field in ("title", "url", "release_date"):
            ours = ep[{"title": "episode_title", "url": "episode_url"}.get(field, field)]
            theirs = meta[field] if field != "title" else re.split(r"\s*\|\s*", meta["title"])[0]
            if ours != theirs:
                problems.append(f"insights/{n:03d}.json: {field} {ours!r} but YouTube says {theirs!r}")
        rows.append({
            "episode_number": n,
            "title": ep["episode_title"],
            "release_date": meta["release_date"],
            "url": meta["url"],
            "duration_minutes": round(meta["duration_seconds"] / 60),
            "view_count": meta["view_count"],
            "like_count": meta["like_count"],
            "comment_count": meta["comment_count"],
            "chapters": meta["chapters"],
            "threads": threads.get(n, []),
            "links_to": cites[n],
            "linked_from": sorted(cited_by.get(n, [])),
            "counts": {field: len(ep[field]) for field in KINDS.values()},
        })
    dump({"fetched": max(load(p)["fetched"] for p in glob.glob(os.path.join(METADATA, "*.json"))),
          "episodes": rows}, os.path.join(DATA, "generated", "episodes.json"))

    for p in problems:
        print(p, file=sys.stderr)
    print(f"{len(rows)} episodes, {len(index)} insights, {len(problems)} problems", file=sys.stderr)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    commands = {"metadata": cmd_metadata, "flatten": cmd_flatten, "build": cmd_build}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        sys.exit(__doc__)
    commands[sys.argv[1]](*sys.argv[2:])
