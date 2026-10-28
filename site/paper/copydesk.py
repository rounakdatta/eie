"""The shape of an edition's copy: site/editions/NNN/copy.json.

The copy is what an edition says, written for one episode: headlines, articles, captions' topics,
the quiz, the crossword's words. Pictures are not in it (site/editions/NNN/media.json holds those,
made by media.py), nor are the parts drawn straight from the archive (the shelf, the laugh lines'
texts, the moments' times), which build-paper.py adds.

Marks in running text: {045-C03} plays an insight's moment; {#name} plays a moment the copy names in
`moments` by a phrase said in the episode; *a title* is set in italics; a paragraph "## Like this" is
a crosshead; a paragraph starting "~ " may be dropped to fit (the engine's coarsest lever).

SCHEMA is the copy's shape, and shape() checks a copy against it; check() checks everything else a
machine can. normalize() reads the empty strings a writer may use for "none" as nulls.
"""

S = {"type": "string"}
INT = {"type": "integer"}


def obj(**props):
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def arr(item):
    return {"type": "array", "items": item}


QUOTE = obj(text=S, item=S)
PERSON = obj(person=S, hint=S)
NULL = {"type": "null"}


def null(x):
    return {"anyOf": [x, NULL]}


# The shape of a copy. (Structured outputs can't hold it: the compiled grammar is too large even
# without the nullable fields. So the writer returns JSON as text, and shape() checks it here.)
SCHEMA = obj(
    moments=arr(obj(name=S, phrase=S)),
    skyline=arr(obj(kicker=S, word=S, colour={"type": "string", "enum": ["magenta", "blue", "red"]}, text=S, to=S)),
    skylinePhoto=null(PERSON),
    footnote=obj(text=S, to=S),
    brief=arr(obj(head=S, text=S)),
    thought=obj(text=S, who=S, item=S),
    lead=obj(kicker=S, head=S, body=arr(S), reel=arr(S), reelLabel=S, reelUnit=S, reelName=S),
    second=obj(item=S, label=S, head=S, deck=S, body=arr(S), quote=QUOTE, photo=null(obj(subject=S, hint=S)), caption=S),
    third=obj(item=S, head=S, body=arr(S), caption=S),
    p2=obj(title=S, deck=S,
           sections=arr(obj(id=S, chapter=null(INT), label=S, head=S, caption=S, body=arr(S), quote=obj(text=S, item=S, who=null(S)), portraits=arr(PERSON))),
           side=obj(photo=null(PERSON), boxTitle=S, boxText=S), contQuote=QUOTE),
    p3=obj(title=S, deck=S,
           stories=arr(obj(id=S, item=S, start=S, end=S, caption=S, kicker=S, head=S, body=arr(S), why=null(S), quote=null(QUOTE), postscript=null(S))),
           numbers=arr(obj(figure=S, text=S, ref=S))),
    shelf=obj(title=S, portraits=arr(PERSON)),
    laughs=obj(title=S, refsTitle=S, funny=arr(S), refs=arr(S), overheard=obj(item=S, text=S, who=S)),
    quiz=arr(obj(q=S, a=S, item=S)),
    glossary=arr({"type": "object", "additionalProperties": False, "required": ["term", "def", "item"],
                  "properties": {"term": S, "def": S, "item": null(S)}}),
    crossword=obj(required=arr(S), words=arr(obj(answer=S, enum=S, clue=S, ref=S))),
    chapters=arr(obj(title=S, short=S)),
)


def shape(value, schema=SCHEMA, path="copy"):
    """Where a value departs from the schema: missing or unknown fields, wrong types."""
    if "anyOf" in schema:
        if value is None:
            return []
        return shape(value, schema["anyOf"][0], path)
    t = schema["type"]
    if t == "object":
        if not isinstance(value, dict):
            return [f"{path}: should be an object"]
        out = [f"{path}.{k}: missing" for k in schema["required"] if k not in value]
        out += [f"{path}.{k}: not a field of the copy" for k in value if k not in schema["properties"] and k not in ("seed", "maxW", "maxH")]
        for k, sub in schema["properties"].items():
            if k in value:
                out += shape(value[k], sub, f"{path}.{k}")
        return out
    if t == "array":
        if not isinstance(value, list):
            return [f"{path}: should be a list"]
        return [e for i, v in enumerate(value) for e in shape(v, schema["items"], f"{path}[{i}]")]
    if t == "string":
        if not isinstance(value, str):
            return [f"{path}: should be a string"]
        if "enum" in schema and value not in schema["enum"]:
            return [f"{path}: should be one of {schema['enum']}"]
        return []
    if t == "integer":
        return [] if isinstance(value, int) and not isinstance(value, bool) else [f"{path}: should be an integer"]
    return []


def normalize(c):
    """The writer's empty strings for "none" (see SCHEMA) as the nulls the paper reads."""
    none = lambda x: x if x else None
    if c.get("skylinePhoto") and not c["skylinePhoto"].get("person"):
        c["skylinePhoto"] = None
    if c["second"].get("photo") and not c["second"]["photo"].get("subject"):
        c["second"]["photo"] = None
    for s in c["p2"]["sections"]:
        if s["chapter"] is not None and s["chapter"] < 0:
            s["chapter"] = None
        s["quote"]["who"] = none(s["quote"].get("who"))
    if c["p2"]["side"].get("photo") and not c["p2"]["side"]["photo"].get("person"):
        c["p2"]["side"]["photo"] = None
    for s in c["p3"]["stories"]:
        s["why"], s["postscript"] = none(s.get("why")), none(s.get("postscript"))
        if s.get("quote") and not s["quote"].get("text"):
            s["quote"] = None
    for g in c["glossary"]:
        g["item"] = none(g.get("item"))
    return c


# ── checks ───────────────────────────────────────────────────────────────────────────────────────

import re  # noqa: E402

MARK = re.compile(r"\{([^}]*)\}")
# fields set through rich(): only these may carry marks and *titles*
RICH = {"body", "text", "who", "boxText", "why", "postscript", "a", "def", "deck"}
PLAIN_DECKS = {("second", "deck"), ("p3", "deck")}


def words(s):
    return len(re.sub(r"\{[^}]*\}|\*|^## |^~ ", "", s).split())


def body_words(paras):
    return sum(words(p) for p in paras if not p.startswith("## "))


def strings(obj, path=""):
    """Every string in the copy with where it is: ("p3.stories[0].body[2]", text, key)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from strings(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from strings(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        yield path, obj, re.sub(r"\[\d+\]", "", path).split(".")[-1]


SMALL = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                    "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if w != "_"}
SCALE = {"hundred": 100, "thousand": 1000, "lakh": 100000, "million": 10 ** 6, "crore": 10 ** 7, "billion": 10 ** 9, "trillion": 10 ** 12}


def heard(text):
    """The numbers in a stretch of transcript, as digit strings: those written as digits, and those
    spoken as words ("twenty five", "four hundred million", and years: "nineteen fifty four")."""
    out = set(re.findall(r"\d+", re.sub(r"(?<=\d)[,.](?=\d)", "", text)))
    # digits and a word together: "40 thousand", "2.5 lakh"
    for num, scale in re.findall(r"(\d+(?:\.\d+)?)\s+(hundred|thousand|lakh|million|crore|billion|trillion)", text.lower()):
        out.add(str(round(float(num) * SCALE[scale])))

    def said(run):
        ws = [w for w in run if w != "and"]
        total = cur = 0
        for w in ws:
            if w in SMALL or w in TENS:
                cur += SMALL.get(w, TENS.get(w, 0))
            elif w == "hundred":
                cur = max(cur, 1) * 100
            else:
                total += max(cur, 1) * SCALE[w]
                cur = 0
        out.add(str(total + cur))
        pairs, i = [], 0   # a year said in pairs: "nineteen fifty four", "twenty twenty three"
        while i < len(ws):
            w = ws[i]
            if w in TENS and i + 1 < len(ws) and SMALL.get(ws[i + 1], 99) < 10:
                pairs.append(TENS[w] + SMALL[ws[i + 1]])
                i += 2
            elif w in TENS or SMALL.get(w, 0) >= 10:
                pairs.append(TENS.get(w, SMALL.get(w)))
                i += 1
            else:
                pairs = []
                break
        if len(pairs) == 2:
            out.add(f"{pairs[0]}{pairs[1]:02d}")

    run = []
    for tok in re.findall(r"[a-z]+|[,.;:!?]", text.lower()) + ["."]:   # punctuation ends a number: "forty thousand, fifty thousand"
        if tok in SMALL or tok in TENS or tok in SCALE or (tok == "and" and run):
            run.append(tok)
            continue
        while run and run[-1] == "and":
            run.pop()
        if run:
            said(run)
        run = []
    return out


def shelf_wide(recs, jokes=99):
    """Whether the shelf takes the page's width: a long one does (more than 28 works), and so does
    one whose episode hasn't the jokes to balance it (Episode 128: 20 works, 11 jokes)."""
    return recs > 28 or jokes - 1 < max(4, min(17, round(recs * 0.63))) - 2


def laughs_for(recs, jokes=99):
    """How many laugh lines balance the shelf: beside one of up to 28 works they must come out as long
    (Episode 45: 27 works, 17 lines), as far as the episode's jokes go; where the shelf takes the page's
    width, the laugh lines join the quiz and Word Watch in a row of three, where five balance them."""
    if shelf_wide(recs, jokes):
        return 5
    return min(max(4, min(17, round(recs * 0.63))), jokes - 1)


def check(copy, ep):
    """What a machine can check of a copy, as (errors, warnings). An error must be fixed before the
    copy is used; a warning is worth a look. `ep` holds the episode: n, items (by ID, with "at" for a
    moment), chapters, and locate(phrase) -> (first, last) word or None."""
    errors, warnings = [], []
    E, W = errors.append, warnings.append
    items, n = ep["items"], ep["n"]
    names, names_at = {}, {}
    for m in copy["moments"]:
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", m["name"]):
            E(f"moments: name {m['name']!r} must be lowercase letters, digits and hyphens")
        if m["name"] in names:
            E(f"moments: {m['name']!r} is named twice")
        names[m["name"]] = m["phrase"]
        if len(m["phrase"].split()) < 6:
            E(f"moments.{m['name']}: the phrase needs 8 to 20 words to be found, has {len(m['phrase'].split())}")
        else:
            hit = ep["locate"](m["phrase"])
            if not hit:
                E(f"moments.{m['name']}: phrase not found in the transcript: {m['phrase']!r}")
            elif ep.get("time"):
                names_at[m["name"]] = ep["time"](hit[0])

    def ref(r, where, kinds=None, playable=True):
        if r.startswith("#"):
            if r[1:] not in names:
                E(f"{where}: {r} is not one of the named moments")
            return
        iid, _, mode = r.partition("|")
        it = items.get(iid)
        if not it:
            E(f"{where}: {iid} is not an item of episode {n}")
            return
        if kinds and iid[4] not in kinds:
            E(f"{where}: {iid} should be a {'/'.join(kinds)} item")
        if playable and "at" not in it:
            E(f"{where}: {iid} is not playable (no moment was found for it); use another item or a named moment")
        if mode and (mode != "whole" or iid[4] != "S"):
            E(f"{where}: {r}: only a story (S) can be played |whole")

    # marks, and where they may be
    used = set()
    for path, s, key in strings(copy):
        if key in ("phrase", "start", "end", "answer", "enum", "item", "ref", "id", "to", "colour", "name", "person", "hint", "subject"):
            continue
        marks = MARK.findall(s)
        rich = key in RICH and not any(path.startswith(a) and path.endswith(b) for a, b in PLAIN_DECKS)
        if marks and not rich:
            E(f"{path}: marks are not allowed here: {s[:60]!r}")
        elif marks and (path == "thought.who" or re.fullmatch(r"(quiz\[\d+\]\.a|glossary\[\d+\]\.def)", path)):
            E(f"{path}: no mark here; the paper adds the mark of its item itself")
        for m in marks:
            ref(m, path)
            if m.startswith("#"):
                used.add(m[1:])
        if s.count("*") % 2:
            E(f"{path}: an unpaired * (italics are *Title*)")
        if "*" in s and not rich and key != "q":   # a quiz question may name a *work*, but carries no mark
            E(f"{path}: italics are not set here: {s[:60]!r}")
        if "—" in s or " – " in s:
            W(f"{path}: an em or en dash; the brief asks for commas, colons and full stops")
        if '"' in s or re.search(r"(?<=\w)'(?=\w)", s):
            W(f"{path}: straight quotes or apostrophes (the build curls them)")
        if len(re.findall(r"\{[^}]*\}", s)) > 1 and key == "body":
            for sent in re.split(r"(?<=[.!?”])\s+", s):
                if len(MARK.findall(sent)) > 1:
                    W(f"{path}: two marks in one sentence")
    for name in names:
        if name not in used and not any(x.get("ref") == f"#{name}" for x in copy["p3"]["numbers"] + copy["crossword"]["words"]):
            W(f"moments.{name}: named but never used")

    # counts
    def count(label, xs, lo, hi):
        if not lo <= len(xs) <= hi:
            E(f"{label}: {len(xs)}, should be {lo}{'' if lo == hi else f' to {hi}'}")
    count("skyline", copy["skyline"], 3, 3)
    count("brief", copy["brief"], 5, 5)
    count("lead.reel", copy["lead"]["reel"], 3, 6)
    count("p2.sections", copy["p2"]["sections"], 3, 6)
    count("p3.stories", copy["p3"]["stories"], 3, 4)
    count("p3.numbers", copy["p3"]["numbers"], 6, 6)
    count("quiz", copy["quiz"], 6, 6)
    count("glossary", copy["glossary"], 6, 6)
    count("crossword.words", copy["crossword"]["words"], 16, 24)
    count("laughs.funny", copy["laughs"]["funny"], 2, 13)
    count("laughs.refs", copy["laughs"]["refs"], 0, 8)
    want = laughs_for(ep.get("recs", 0), ep.get("jokes", 99))
    got = len(copy["laughs"]["funny"]) + len(copy["laughs"]["refs"])
    if ep.get("recs") and abs(got - want) > 2:
        E(f"laughs: {got} laugh lines in all (funny and refs); with {ep['recs']} recommendations on the shelf beside them, it should be {want}")
    count("shelf.portraits", copy["shelf"]["portraits"], 0, 3)
    if len({s["colour"] for s in copy["skyline"]}) < 3:
        W("skyline: use each colour once")

    # references
    for k, r in enumerate(copy["lead"]["reel"]):
        ref(r, f"lead.reel[{k}]")
    ref(copy["thought"]["item"], "thought.item")
    ref(copy["second"]["item"], "second.item", "SC")
    ref(copy["second"]["quote"]["item"], "second.quote.item")
    ref(copy["third"]["item"], "third.item", "SC")
    ids = {}
    for where, xs in (("p2.sections", copy["p2"]["sections"]), ("p3.stories", copy["p3"]["stories"])):
        for k, x in enumerate(xs):
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,20}", x["id"]):
                E(f"{where}[{k}].id: {x['id']!r} must be a short lowercase slug")
            if x["id"] in ids or x["id"] in ("lead", "second", "third", "p1", "p2", "p3", "p4", "from1", "numbers", "shelf", "laughs", "quiz", "gloss", "crossword", "clues"):
                E(f"{where}[{k}].id: {x['id']!r} is already taken")
            ids[x["id"]] = where
    for k, s in enumerate(copy["p2"]["sections"]):
        ref(s["quote"]["item"], f"p2.sections[{k}].quote.item")
        if s["chapter"] is not None and not 0 <= s["chapter"] < len(ep["chapters"]):
            E(f"p2.sections[{k}].chapter: {s['chapter']} is not a chapter index (0 to {len(ep['chapters']) - 1})")
        count(f"p2.sections[{k}].portraits", s["portraits"], 0, 2)
    ref(copy["p2"]["contQuote"]["item"], "p2.contQuote.item")
    targets = set(ids) | {"lead", "second", "third", "numbers", "shelf", "laughs", "quiz"}
    for k, s in enumerate(copy["skyline"]):
        if s["to"] not in targets:
            E(f"skyline[{k}].to: {s['to']!r} is not a section or story id")
    if copy["footnote"]["to"] not in targets:
        E(f"footnote.to: {copy['footnote']['to']!r} is not a section or story id")
    for k, s in enumerate(copy["p3"]["stories"]):
        ref(s["item"], f"p3.stories[{k}].item", "S")
        if s["quote"]:
            ref(s["quote"]["item"], f"p3.stories[{k}].quote.item")
        if not s["why"] and not s["quote"]:
            E(f"p3.stories[{k}]: needs a why or a quote")
        a, b = ep["locate"](s["start"]), ep["locate"](s["end"])
        if not a:
            E(f"p3.stories[{k}].start: not found in the transcript: {s['start']!r}")
        if not b:
            E(f"p3.stories[{k}].end: not found in the transcript: {s['end']!r}")
        if a and b:
            t0, t1 = ep["time"](a[0]), ep["time"](b[1])
            at = items.get(s["item"], {}).get("at")
            if t1 <= t0:
                E(f"p3.stories[{k}]: its end comes before its start")
            elif not 15 <= t1 - t0 <= 900:
                E(f"p3.stories[{k}]: the telling runs {t1 - t0:.0f} s; a story's start and end should be 15 s to 15 min apart")
            elif at and not t0 - 5 <= at[0] / 100 <= t1 + 5:
                W(f"p3.stories[{k}]: its insight's moment ({at[0] / 100:.0f} s) is outside its telling ({t0:.0f} to {t1:.0f} s)")
    for k, x in enumerate(copy["p3"]["numbers"]):
        ref(x["ref"], f"p3.numbers[{k}].ref")
    L = copy["laughs"]
    for k, j in enumerate(L["funny"]):
        ref(j, f"laughs.funny[{k}]", "J", playable=False)
        if items.get(j, {}).get("type", "humor") != "humor":
            E(f"laughs.funny[{k}]: {j} is not a humor item")
    for k, j in enumerate(L["refs"]):
        ref(j, f"laughs.refs[{k}]", "J", playable=False)
        if items.get(j, {}).get("type") == "humor":
            E(f"laughs.refs[{k}]: {j} is a humor item (put it in funny)")
    ref(L["overheard"]["item"], "laughs.overheard.item", "J")
    if L["overheard"]["item"] in L["funny"] + L["refs"]:
        E("laughs.overheard: its item is already in the list")
    if len(set(L["funny"] + L["refs"])) != len(L["funny"] + L["refs"]):
        E("laughs: an item is listed twice")
    for k, q in enumerate(copy["quiz"]):
        ref(q["item"], f"quiz[{k}].item")
    for k, g in enumerate(copy["glossary"]):
        if g["item"]:
            ref(g["item"], f"glossary[{k}].item")

    # quotes: the speaker's own words
    quotes = [("thought", copy["thought"]["text"]), ("second.quote", copy["second"]["quote"]["text"]),
              ("p2.contQuote", copy["p2"]["contQuote"]["text"]), ("laughs.overheard", L["overheard"]["text"])]
    quotes += [(f"p2.sections[{k}].quote", s["quote"]["text"]) for k, s in enumerate(copy["p2"]["sections"])]
    quotes += [(f"p3.stories[{k}].quote", s["quote"]["text"]) for k, s in enumerate(copy["p3"]["stories"]) if s["quote"]]
    for where, q in quotes:
        if len(q.split()) >= 4 and not ep["locate"](q):
            E(f"{where}: not found in the transcript as said: {q!r}")

    # said in this episode: a glossary term or a crossword answer must be in its transcript or its
    # insights (which spell names right), never borrowed from the model edition
    said = ep.get("said")
    if said:
        squash = lambda x: re.sub(r"[^a-z0-9]", "", x.lower())
        for k, g in enumerate(copy["glossary"]):
            if squash(g["term"]) not in said and not all(squash(w) in said for w in re.findall(r"[A-Za-z]{4,}", g["term"])):
                E(f"glossary[{k}]: {g['term']!r} is not said in this episode (nothing may be borrowed from another edition)")
        for k, w in enumerate(copy["crossword"]["words"]):
            if squash(w["answer"]) not in said:
                E(f"crossword.words[{k}]: {w['answer']!r} is not said in this episode")
    # a figure should be heard near where its ref plays (the transcript writes most numbers as digits)
    near = ep.get("near")
    if near:
        for k, x in enumerate(copy["p3"]["numbers"]):
            groups = [g for g in re.findall(r"\d+", x["figure"].replace(",", "")) if len(g) >= 2]   # "16–26" is two numbers
            r = x["ref"]
            if r.startswith("#"):
                at = names_at.get(r[1:])
            else:
                it = items.get(r.split("|")[0]) or {}
                at = it["at"][0] / 100 if "at" in it else None
            got = heard(near(at - 45, at + 45)) if at is not None and groups else set()
            if groups and at is not None and not all(any(g in h for h in got) for g in groups):
                W(f"p3.numbers[{k}]: {x['figure']!r} is not heard within 45 s of {r}; check it was said there")

    # the crossword
    cw = copy["crossword"]
    answers = [w["answer"] for w in cw["words"]]
    for k, w in enumerate(cw["words"]):
        a = w["answer"]
        if not re.fullmatch(r"[A-Z]{3,13}", a):
            E(f"crossword.words[{k}]: {a!r} must be 3 to 13 capital letters A to Z")
        if not re.fullmatch(r"\d+([,-]\d+)*", w["enum"]) or sum(map(int, re.findall(r"\d+", w["enum"]))) != len(a):
            E(f"crossword.words[{k}]: enum {w['enum']!r} doesn't add up to {a!r} ({len(a)} letters)")
        ref(w["ref"], f"crossword.words[{k}].ref")
    if len(set(answers)) != len(answers):
        E("crossword: an answer is listed twice")
    for r in cw["required"]:
        if r not in answers:
            E(f"crossword.required: {r!r} is not one of the answers")
    count("crossword.required", cw["required"], 6, 12)

    # chapters
    # the strip names every chapter of 30 seconds or more
    ch = ep["chapters"]
    long = [c["title"] for i, c in enumerate(ch) if (ch[i + 1]["start"] if i + 1 < len(ch) else ep["seconds"]) - c["start"] >= 30]
    got = [c["title"] for c in copy["chapters"]]
    missing, extra = [t for t in long if t not in got], [t for t in got if t not in [c["title"] for c in ch]]
    if missing or extra:
        E(f"chapters: must name every chapter exactly as listed; missing {missing}, unknown {extra}")
    for c in copy["chapters"]:
        if len(c["short"]) > 16:
            W(f"chapters: {c['short']!r} is longer than 16 characters")

    # lengths
    def chars(label, s, hi):
        if len(s) > hi:
            E(f"{label}: {len(s)} characters, at most {hi}: {s!r}")

    def span(label, n, lo, hi, hard=0.2):
        if n < lo * (1 - hard) or n > hi * (1 + hard):
            E(f"{label}: {n} words, should be {lo} to {hi}")
        elif not lo <= n <= hi:
            W(f"{label}: {n} words, should be {lo} to {hi}")
    for k, s in enumerate(copy["skyline"]):
        chars(f"skyline[{k}].kicker", s["kicker"], 18)
        chars(f"skyline[{k}].word", s["word"], 9)
        span(f"skyline[{k}].text", words(s["text"]), 7, 11)
    for k, b in enumerate(copy["brief"]):
        chars(f"brief[{k}].head", b["head"], 22)
        span(f"brief[{k}].text", words(b["text"]), 20, 30)
    span("thought.text", words(copy["thought"]["text"]), 3, 14)
    span("thought.who", words(copy["thought"]["who"]), 5, 18)
    chars("lead.kicker", copy["lead"]["kicker"], 55)
    chars("lead.head", copy["lead"]["head"], 34)
    chars("lead.reelLabel", copy["lead"]["reelLabel"], 28)
    span("lead.body", body_words(copy["lead"]["body"]), 470, 560)
    chars("second.label", copy["second"]["label"], 24)
    chars("second.head", copy["second"]["head"], 24)
    span("second.deck", words(copy["second"]["deck"]), 5, 14)
    span("second.body", body_words(copy["second"]["body"]), 95, 120)
    span("second.quote", words(copy["second"]["quote"]["text"]), 6, 22)
    chars("third.head", copy["third"]["head"], 26)
    span("third.body", body_words(copy["third"]["body"]), 115, 135)
    chars("p2.title", copy["p2"]["title"], 22)
    span("p2.deck", words(copy["p2"]["deck"]), 6, 20)
    for k, s in enumerate(copy["p2"]["sections"]):
        chars(f"p2.sections[{k}].label", s["label"], 20)
        chars(f"p2.sections[{k}].head", s["head"], 30)
        chars(f"p2.sections[{k}].caption", s["caption"], 60)
        span(f"p2.sections[{k}].body", body_words(s["body"]), *((200, 240) if k == 0 else (170, 220)))
        span(f"p2.sections[{k}].quote", words(s["quote"]["text"]), 5, 24)
        if not any(p.startswith("~ ") for p in s["body"][1:]):
            W(f"p2.sections[{k}]: no paragraph marked ~ (optional)")
    chars("p2.side.boxTitle", copy["p2"]["side"]["boxTitle"], 30)
    span("p2.side.boxText", words(copy["p2"]["side"]["boxText"]), 30, 45)
    span("p2.contQuote", words(copy["p2"]["contQuote"]["text"]), 20, 40)
    stories = copy["p3"]["stories"]
    for k, s in enumerate(stories):
        chars(f"p3.stories[{k}].kicker", s["kicker"], 60)
        chars(f"p3.stories[{k}].head", s["head"], 34)
        lo, hi = (230, 270) if len(stories) == 4 and k == 0 else (110, 140) if len(stories) == 4 else (130, 160)
        span(f"p3.stories[{k}].body", body_words(s["body"]), lo, hi)
        if s["why"]:
            span(f"p3.stories[{k}].why", words(s["why"]), 30, 45)
        if s["postscript"]:
            span(f"p3.stories[{k}].postscript", words(s["postscript"]), 5, 25)
        if not any(p.startswith("~ ") for p in s["body"][1:]):
            W(f"p3.stories[{k}]: no paragraph marked ~ (optional)")
    for k, x in enumerate(copy["p3"]["numbers"]):
        chars(f"p3.numbers[{k}].figure", x["figure"], 7)
        span(f"p3.numbers[{k}].text", words(x["text"]), 8, 14)
    for k, q in enumerate(copy["quiz"]):
        span(f"quiz[{k}].q", words(q["q"]), 5, 20)
        span(f"quiz[{k}].a", words(q["a"]), 10, 16)
    for k, g in enumerate(copy["glossary"]):
        chars(f"glossary[{k}].term", g["term"], 26)
        span(f"glossary[{k}].def", words(g["def"]), 6, 12)
    span("laughs.overheard.text", words(L["overheard"]["text"]), 5, 24)
    for k, w in enumerate(cw["words"]):
        span(f"crossword.words[{k}].clue", words(w["clue"]), 2, 13)
    return errors, warnings
