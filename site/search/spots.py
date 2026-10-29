"""The places a reader can be sent to: every piece of an edition that says something, with the anchor
it has on the page. Shared by the search server (server.py) and the hooks writer (hooks.py), and kept in
step with the ids paper-src.js gives the same pieces.

  spots(edition, n) -> [{"a": anchor, "page": 1-4, "kind": ..., "head": ..., "text": ..., "item": ...}]
"""
import re

SOFT = "­"


def clean(s):
    """Copy as a reader sees it: no moment marks, no italics stars, no soft hyphens."""
    s = (s or "").replace(SOFT, "")
    s = re.sub(r"\s*\{[^}]*\}|\[\[[^\]]*\]\]", "", s)   # moment marks, cross-reference marks
    s = s.replace("*", "")
    return re.sub(r"\s+", " ", s).strip()


def para(p):
    """A body paragraph: a string, or (for an optional one) a string starting "~ "."""
    return clean(p[2:] if isinstance(p, str) and p.startswith("~ ") else p if isinstance(p, str) else p.get("text", ""))


def spots(E, n):
    out = []

    def add(a, page, kind, head, text, item=None, kicker="", lede=None):
        text = clean(text)
        if head or text:   # the lede is what a reader is shown of it: a story's first paragraph, not its caption
            out.append({"a": a, "page": page, "kind": kind, "head": clean(head), "kicker": clean(kicker), "text": text, "item": item,
                        "lede": clean(lede) if lede else text})

    P1, P2, P3, P4 = E["p1"], E["p2"], E["p3"], E["p4"]
    L = P1["lead"]
    add("lead", 1, "lead", L["head"], " ".join(para(p) for p in L["body"]), kicker=L.get("kicker", ""), lede=para(L["body"][0]))
    S = P1["second"]
    add(S["id"], 1, "story", S["head"], " ".join([S.get("deck", "")] + [para(p) for p in S["body"]] + [(S.get("quote") or {}).get("text", "")]),
        item=(S.get("quote") or {}).get("item"), kicker=S.get("label", ""), lede=para(S["body"][0]))
    T = P1["third"]
    add(T["id"], 1, "story", T["head"], " ".join(para(p) for p in T["body"]), item=(T.get("listen") or [{}])[0].get("item"))
    for k, b in enumerate(P1["brief"]):
        add(f"brief-{k + 1}", 1, "brief", b["head"], b["text"])
    th = P1.get("thought")
    if th:
        add("thought", 1, "thought", "Thought for the day", f"{th['text']} {th.get('who', '')}", item=th.get("item"))
    side = P2.get("side") or {}
    if side.get("box"):
        add("side", 2, "box", side["box"]["title"], side["box"]["text"])
    for s in P2["sections"]:
        add(s["id"], 2, "opinion", s["head"], " ".join([s.get("caption", "")] + [para(p) for p in s["body"]] + [(s.get("quote") or {}).get("text", "")]),
            item=(s.get("quote") or {}).get("item"), kicker=s.get("label", ""), lede=para(s["body"][0]))
    for s in P3["stories"]:
        add(s["id"], 3, "story", s["head"], " ".join([para(p) for p in s["body"]] + [s.get("why") or "", s.get("postscript") or "", (s.get("quote") or {}).get("text", "") if isinstance(s.get("quote"), dict) else ""]),
            item=s.get("item"), kicker=s.get("kicker", ""), lede=para(s["body"][0]))
    for k, x in enumerate(P3["numbers"]):
        add(f"num-{k + 1}", 3, "number", x["figure"], x["text"], item=x.get("ref"))
    for b in E["shelf"]:
        add(f"r-{b['id']}", 4, "shelf", b["title"], f"{b.get('creator', '')} · {b.get('type', '')}. {b.get('why', '')}", item=b["id"])
    O = (P4.get("laughs") or {}).get("overheard")
    if O:
        add("overheard", 4, "laugh", "Overheard", f"{O['text']} {O.get('who', '')}", item=O.get("item"))
    for j in E.get("laughs", []):
        add(f"j-{j['id']}", 4, "laugh", "", j["text"], item=j["id"])
    for k, g in enumerate(P4["glossary"]):
        add("word" if k == 0 else f"g-{k}", 4, "word", g["term"], g["def"], item=g.get("item"))
    for s in out:
        s["id"] = f"{n}#{s['a']}"
    return out
