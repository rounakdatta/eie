#!/usr/bin/env python3
"""A criss-cross crossword from an episode's own words.

Words are placed one by one where they cross words already placed, never touching any other
letter side by side (so no accidental words form), and many random orders are tried; the layout
that places the most words, with the most crossings, in the most compact box wins. The result is
deterministic for a given seed.
"""
import random


def build(words, seed=45, tries=4000, aspect=1.25, max_w=99, max_h=99, required=()):
    """words: [(answer, ...)]; returns a layout: placed [(answer, row, col, 'a'|'d')], w, h. No
    layout may grow beyond max_w by max_h; words that cannot be placed inside it are left out."""
    rng = random.Random(seed)
    best = None
    answers = [w for w, *_ in words]
    for _ in range(tries):
        # the required words first, longest first; then the rest in a random order
        req = sorted([w for w in answers if w in required], key=lambda w: (-len(w), rng.random()))
        rest = [w for w in answers if w not in required]
        rng.shuffle(rest)
        if rng.random() < 0.5 and len(req) > 2:   # sometimes interleave, so short words can bridge
            mid = req[2:] + rest
            rng.shuffle(mid)
            order = req[:2] + mid
        else:
            order = req + rest
        layout = _place(order, rng, max_w, max_h)
        if layout is None:
            continue
        names = {p[0] for p in layout["placed"]}
        if any(w not in names for w in required):
            continue
        score = _score(layout, aspect)
        if best is None or score > best[0]:
            best = (score, layout)
    return best[1] if best else None


def _place(order, rng, max_w=99, max_h=99):
    cells = {}
    placed = []
    box = [0, 0, 0, 0]   # min row, max row, min col, max col

    def fits(word, r, c, d):
        dr, dc = (0, 1) if d == "a" else (1, 0)
        # the cells just before and after the word must be empty
        if (r - dr, c - dc) in cells or (r + dr * len(word), c + dc * len(word)) in cells:
            return -1
        crossings = 0
        for i, ch in enumerate(word):
            rr, cc = r + dr * i, c + dc * i
            have = cells.get((rr, cc))
            if have:
                # a mismatch, running along another word, or a cell two words already cross
                if have[0] != ch or have[1] in (d, "x"):
                    return -1
                crossings += 1
            else:
                # a new letter may not sit beside another letter across the word's direction
                for nr, nc in ((rr + dc, cc + dr), (rr - dc, cc - dr)):
                    if (nr, nc) in cells:
                        return -1
        return crossings

    first = order[0]
    for i, ch in enumerate(first):
        cells[(0, i)] = (ch, "a")
    placed.append((first, 0, 0, "a"))
    box[:] = [0, 0, 0, len(first) - 1]
    for word in order[1:]:
        options = []
        for (r, c), (ch, d0) in list(cells.items()):
            if d0 == "x":
                continue
            for i, wch in enumerate(word):
                if wch != ch:
                    continue
                d = "d" if d0 == "a" else "a"
                sr, sc = (r - i, c) if d == "d" else (r, c - i)
                k = fits(word, sr, sc, d)
                if k > 0:
                    er, ec = (sr + len(word) - 1, sc) if d == "d" else (sr, sc + len(word) - 1)
                    if max(box[1], er) - min(box[0], sr) + 1 > max_h or max(box[3], ec) - min(box[2], sc) + 1 > max_w:
                        continue
                    options.append((k, rng.random(), sr, sc, d))
        if not options:
            continue
        options.sort(reverse=True)
        k, _, sr, sc, d = options[0] if rng.random() < 0.7 else rng.choice(options)
        dr, dc = (0, 1) if d == "a" else (1, 0)
        for i, ch in enumerate(word):
            key = (sr + dr * i, sc + dc * i)
            if key in cells:
                cells[key] = (ch, "x")   # a crossing belongs to both directions
            else:
                cells[key] = (ch, d)
        placed.append((word, sr, sc, d))
        er, ec = (sr + len(word) - 1, sc) if d == "d" else (sr, sc + len(word) - 1)
        box[:] = [min(box[0], sr), max(box[1], er), min(box[2], sc), max(box[3], ec)]
    rows = [r for r, _ in cells]
    cols = [c for _, c in cells]
    r0, c0 = min(rows), min(cols)
    placed = [(w, r - r0, c - c0, d) for w, r, c, d in placed]
    return {"placed": placed, "h": max(rows) - r0 + 1, "w": max(cols) - c0 + 1, "cells": len(cells)}


def _score(layout, aspect):
    placed, h, w = layout["placed"], layout["h"], layout["w"]
    letters = sum(len(p[0]) for p in placed)
    crossings = letters - layout["cells"]
    shape = abs((w / h) - aspect)
    return (len(placed), crossings, -(w * h), -shape)


def number(layout):
    """Standard numbering: reading row by row, a cell that starts a word gets the next number."""
    starts = {}
    for word, r, c, d in layout["placed"]:
        starts.setdefault((r, c), []).append((word, d))
    out, n = [], 0
    for (r, c) in sorted(starts):
        n += 1
        for word, d in starts[(r, c)]:
            out.append({"n": n, "dir": d, "r": r, "c": c, "answer": word})
    return out
