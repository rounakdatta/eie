"""Static checks of the built cross-references: every target is a place in its edition; no mark sits
inside a word; two marks side by side keep the order chosen (the stronger first).

  python3 site/tools/xrefs-check.py      # after a build, before a verify; exits 1 on any fault"""
import glob, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "search"))
from spots import spots
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "editions")
E = {int(f.split("/")[-2]): json.load(open(f, encoding="utf-8")) for f in sorted(glob.glob(f"{ROOT}/[0-9][0-9][0-9]/edition.json"))}
places = {n: {s["a"] for s in spots(e, n)} for n, e in E.items()}
bad_target, inword, reversed_, pairs, marks = [], [], [], 0, 0
for n, e in E.items():
    xr = e.get("xrefs") or {}
    marks += len(xr)
    for k, x in xr.items():
        if x["a"] not in places.get(x["ep"], ()):
            bad_target.append(f"{n}:{k}->{x['ep']}#{x['a']}")
    text = json.dumps(e, ensure_ascii=False)
    for m in re.finditer(r"\[\[(x\d+)\]\](?=[^\W_])", text):
        inword.append(f"{n}:{m.group(1)} …{text[max(0, m.start() - 25):m.end() + 10]}")
    for m in re.finditer(r"\[\[x(\d+)\]\]\[\[x(\d+)\]\]", text):
        pairs += 1
        if int(m.group(1)) > int(m.group(2)):
            reversed_.append(f"{n}:x{m.group(1)},x{m.group(2)}")
    # a token in the copy with no entry, or an entry with no token
    toks = set(re.findall(r"\[\[(x\d+)\]\]", text))
    if toks != set(xr):
        bad_target.append(f"{n}: tokens {sorted(toks ^ set(xr))} unmatched")
print(f"{len(E)} editions, {marks} marks; targets missing: {len(bad_target)} {bad_target[:5]}")
print(f"inside a word: {len(inword)} {inword[:5]}")
print(f"side by side: {pairs}, reversed: {len(reversed_)} {reversed_[:5]}")
sys.exit(1 if bad_target or inword or reversed_ else 0)
