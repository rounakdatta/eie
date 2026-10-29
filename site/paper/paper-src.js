// Everything is Everything as a newspaper, after The Telegraph's Calcutta edition.
//
// The pages are typeset, not just laid out. Every block sits on one baseline grid; each row of
// stories ("band") is given one depth; and every story is fitted to it the way a sub-editor would:
// its picture is given more or fewer lines, its pull quote a larger or smaller size, its text a
// hair's tracking, until every column of type ends on the band's last line. A story too long for
// its space is cut at the line and continued on an inside page. Phones read the paper story by
// story instead ("article mode"), where none of this is needed.
//
// build-paper.py makes paper.js from this file, splicing in the helpers and the moment player
// from ../app.js. Every edition's page is the same: /45/index.html names its episode, and reads its
// edition.json, data.json and media/ beside it.

const EP = +document.body.dataset.ep;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NAMES = ["Amit Varma", "Ajay Shah", "someone else"];
const FIRST = ["Amit", "Ajay", "Someone else"];
let D, A, E, WORDS;   // the episode, the archive (unused here), this edition, the episode's words

//@include helpers

//@include player

const MEDIA = "media/", SHARED = "../paper/media/", COVERS = "../covers/";
const GLASS = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12.6 12.6 17 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const LH = 22, GUT = 22;
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const item = (id) => D.items.find((i) => i.id === id);

/* ── moments ──────────────────────────────────────────────── */

/* "045-C03" is an insight's moment, "045-S01|whole" a story from its start, "#ipo" a moment the
   edition names by a phrase. */
function momentOf(ref) {
  if (!ref) return null;
  if (ref.startsWith("#")) {
    const m = E.moments[ref.slice(1)];
    return m && { ...m, ep: EP, videoId: D.episode.videoId };
  }
  const [id, mode] = ref.split("|");
  const it = item(id);
  if (!it?.clip) return null;
  const span = E.spans?.[id] || it.span;
  if (mode === "whole" && span) return { ...here(it), clip: span, at: [span[0]], title: `${titleOf(it)} (the whole story)` };
  return here(it);
}

/* A moment in the run of the text: a small disc and the time it was said. */
function say(m, label, aria) {
  if (!m) return null;
  const b = h("button", { type: "button", class: "say", "data-s": m.spk ?? 2, title: `${FIRST[m.spk ?? 2]}, ${clock(m.at[0])}`, "aria-label": aria || `Hear it: ${FIRST[m.spk ?? 2]}, at ${clock(m.at[0])}` },
    h("span", { class: "disc", html: PLAY }), h("span", { class: "lbl t" }, label ?? clock(m.at[0])));
  b.addEventListener("click", () => Player.play(m, b));
  b.addEventListener("pointerenter", () => Player.warm(), { once: true });
  return b;
}

/* The edition's markup: *a title*, and {ref} for a moment. A moment is bound to the word before
   it, so it never wraps to the start of a line on its own. */
function rich(s) {
  const frag = document.createDocumentFragment();
  for (const part of s.split(/(\{[^}]*\}|\*[^*]+\*|\[\[[^\]]+\]\])/)) {
    if (!part) continue;
    if (part.startsWith("{")) {
      const c = say(momentOf(part.slice(1, -1)));
      if (!c) continue;
      bind(frag, c);
    } else if (part.startsWith("[[")) {
      // not bound to the word before it, as a play mark is: with a line allowed to break before it, the
      // widest piece that can't break is the mark and a stop (a name bound to it ran out of narrow columns)
      const key = part.slice(2, -2), x = E.xrefs?.[key];
      if (x) frag.append("\u200b", xmark(x, key));
    } else if (part.startsWith("*")) frag.append(h("em", {}, part.slice(1, -1).replace(/\[\[[^\]]*\]\]/g, "")));   // never a mark's raw token
    else frag.append(part);
  }
  return frag;
}
/* A cross-reference to another edition, set as a paper sets one ("see No. 66"): where the same story, idea
   or person is taken up. Its title says where it leads; the desk (desk.js) takes the reader there, rings
   the place, and offers the way back. */
const xmark = (x, key) => h("a", { class: "xref", id: `xr-${key}`, href: `../${x.ep}/#${x.a}`, "data-ep": x.ep, "data-a": x.a,
  "data-page": x.page, "data-head": x.head, "data-label": x.label, "aria-label": `See also No. ${x.ep}, page ${x.page}: ${x.head}` },
`→\u2009No.\u00a0${x.ep}`);

/* A paragraph; "## " makes it a crosshead, and "~ " one the engine may leave out to fit. */
const para = (s, cls) => (s.startsWith("## ") ? h("h4", {}, s.slice(3))
  : s.startsWith("~ ") ? h("p", { class: `opt ${cls || ""}`.trim() }, rich(s.slice(2))) : h("p", { class: cls }, rich(s)));

/* Bind a mark to the last syllable of the text before it, so the mark never starts a line alone
   while the word can still hyphenate before that syllable. (Binding the whole word made it a wide
   unbreakable block that stretched the justified line above; a word joiner, Chrome ignores
   before a button.) */
function bind(parent, mark) {
  const prev = parent.lastChild;
  if (!mark) return parent;
  // a mark right after another (a cross-reference after a play mark): a line may break between them, or
  // the word and both marks were one unbreakable piece that ran out of a narrow column
  if (prev?.nodeType !== 3) { if (prev) parent.append("\u200b"); parent.append(mark); return parent; }
  const m = prev.data.match(/(\S+)\s*$/);
  if (!m) { parent.append(mark); return parent; }
  const word = m[1], cut = word.lastIndexOf("\u00ad") + 1;
  prev.data = prev.data.slice(0, m.index) + word.slice(0, cut);
  parent.append(h("span", { class: "nb" }, word.slice(cut), mark));
  return parent;
}
/* A paragraph of text and then its mark, bound. */
const withMark = (content, mark) => bind(content instanceof Node ? content : rich(content), mark);

/* ── building blocks ──────────────────────────────────────── */

function mod(span, cls, attrs, ...kids) {
  return h("div", { ...attrs, class: `mod ${cls}`.trim(), style: { "--span": span } }, ...kids);
}
const snap = (tag, cls, ...kids) => h(tag, { class: `${cls} snap`.trim() }, ...kids);
const text = (cols, cls, kids) => h("div", { class: `text ${cls || ""}`.trim(), "data-cols": cols }, kids);
const gap = () => h("div", { class: "gap" });

function longDay(iso) {   // a newspaper's dateline: Friday 3 May 2024
  return new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "");
}

/* A picture whose depth the engine chooses, within the crop its subject allows (data-r: the
   least, natural and most height for its width). A fixed one keeps its natural crop. A video is
   a silent loop from the episode; its button plays the moment with sound. */
function picture(pic) {
  if (!pic) return [];   // an edition may lack a picture; the story stands without one
  const { src, video, poster, caption, credit, focus = "50% 40%", ratio = [0.5, 0.5625, 0.7], play, fixed, frame } = pic;
  const fig = h("figure", { class: `pic${fixed ? "" : " elastic"}${frame ? " frame" : ""}`, "data-r": ratio.join(","), "data-fixed": fixed ? "" : null, style: { "--ar": (1 / ratio[1]).toFixed(4) } });
  if (video) {
    const v = h("video", { src: MEDIA + video, poster: MEDIA + poster, muted: true, loop: true, playsinline: true, preload: "metadata", "aria-hidden": "true", style: { objectPosition: focus } });
    v.muted = true;
    fig.append(v, h("span", { class: "moving", "aria-hidden": "true" }, "Moving picture"));
    Loops.watch(v);
  } else {
    fig.append(h("img", { src: MEDIA + src, alt: caption || "", style: { objectPosition: focus } }));
  }
  if (play) fig.append(watchButton(play));
  // a photo credit sits small and to the right, as a newspaper sets it; a caption, centred, under it
  const cap = caption ? h("p", { class: "cap snap", "data-gap": "8" }, caption, credit ? h("span", { class: "credit" }, ` ${credit}`) : null)
    : credit ? h("p", { class: "cap credit-only snap", "data-gap": "6" }, credit) : null;
  return [fig, cap];
}

function watchButton(play) {
  let m, label, onplay;
  if (play.reel) {
    const reel = play.reel.map((id) => momentOf(id));
    const total = reel.reduce((s, x) => s + x.clip[1] - x.clip[0], 0);
    m = reel[0]; label = `${play.label} · ${length(total)}`;
    onplay = (b) => Player.play(reel[0], b, reel.slice(1));
  } else if (play.chapter != null) {
    const c = D.episode.chapters[play.chapter], t = c.start * 100;
    m = { ep: EP, videoId: D.episode.videoId, clip: [t, t + 6000], at: [t], spk: speakerAt(t + 200), free: true, title: chapterName(c.title) };
    label = `Listen from ${clock(t)}`;
  } else {
    m = momentOf(play.mode === "whole" ? `${play.item}|whole` : play.item);
    label = play.mode === "whole" ? `The whole story · ${length(m.clip[1] - m.clip[0])}` : `Hear it · ${clock(m.at[0])}`;
  }
  const b = h("button", { type: "button", class: "watch", "data-s": m.spk ?? 2, "aria-label": label },
    h("span", { class: "disc", html: PLAY }), label);
  b.addEventListener("click", () => (onplay ? onplay(b) : Player.play(m, b)));
  b.addEventListener("pointerenter", () => Player.warm(), { once: true });
  return b;
}

function speakerAt(t) { return WORDS.s[Math.max(0, upper(WORDS.t, t) - 1)]; }

function pullQuote({ text: q, item: id, who }, sizes = "17,19,21,23,25", label, pad = 10) {
  const m = momentOf(id);
  return h("figure", { class: "quote elastic", "data-sizes": sizes, "data-pad": String(pad) },
    label ? h("p", { class: "answers-label" }, label) : null,
    h("q", {}, q), h("figcaption", { class: "who" }, who ? rich(who) : NAMES[m?.spk ?? 2], say(m)));
}

function listen(items) {
  return snap("p", "listen", ...items.flatMap((l, k) => {
    const m = momentOf(l.mode === "whole" ? `${l.item}|whole` : l.item);
    const label = l.mode === "whole" ? `The whole story · ${length(m.clip[1] - m.clip[0])}` : `The line · ${clock(m.at[0])}`;
    return [k ? "  " : null, say(m, label)];
  }));
}

function runhead(n, section) {
  return h("div", { class: "runhead" }, h("span", { class: "n t" }, String(n)), h("span", { class: "sec" }, section),
    h("span", {}, "Everything is Everything"), h("span", { class: "date t" }, longDay(D.episode.date)));
}

function portraits(list, per = [1.0, 1.25, 1.6], least = 1) {
  // the row's depth for its width: each portrait's own proportions, shared across the row. Fewer
  // portraits than `least` keep the size they'd have in a row of `least`, centred: one portrait
  // across a whole story was a poster, not a picture
  const slots = Math.max(least, list.length), k = 1 / slots;
  return h("div", { class: "portraits pic elastic", "data-r": per.map((x) => (x * k).toFixed(3)).join(","), style: { "--n": list.length, "--slots": slots, "--ar": (slots / per[1]).toFixed(3) } },
    list.map((p) => h("figure", {}, h("div", { class: "pic" }, h("img", { src: MEDIA + p.src, alt: p.caption })),
      h("figcaption", { class: "cap" }, p.caption, h("span", { class: "credit" }, ` ${p.credit}`)))));
}

/* ── page one ─────────────────────────────────────────────── */

/* The edition bar, over the nameplate: this paper's place in the run, and the ways along it. */
function edbar() {
  const N = E.nav;
  const link = (x, cls, label, text) => (x
    ? h("a", { class: cls, href: `../${x.n}/`, title: x.head, "aria-label": `${label}: Episode ${x.n}, ${x.head}` }, text)
    : h("span", { class: cls }));
  return h("nav", { class: "edbar", "aria-label": "Editions" },
    // on the narrowest phones the word "Episode" gives way, so the bar keeps to one line
    link(N.prev, "prev", "The edition before", ["‹ ", h("span", { class: "w" }, "Episode "), `${N.prev?.n}`]),
    // the archive desk (paper/desk.js) sits beside the way back to every edition: "/" opens it too
    h("span", { class: "mid" }, h("a", { class: "all", href: "../" }, `All ${N.total} editions`),
      h("button", { type: "button", class: "find", "aria-haspopup": "dialog", "aria-keyshortcuts": "/", "aria-label": "Lost & Found: find something you half-remember",
        onclick: (ev) => document.dispatchEvent(new CustomEvent("eie:desk", { detail: ev.currentTarget })) },
      h("span", { class: "glass", html: GLASS }), h("span", { class: "long" }, "Lost & Found"), h("span", { class: "short" }, "Find"))),
    link(N.next, "next", "The next edition", [h("span", { class: "w" }, "Episode "), `${N.next?.n} ›`]));
}

function page1() {
  const e = D.episode, M = E.masthead, P = E.p1;
  const page = h("article", { class: "page", id: "p1", "aria-label": "Page 1" });
  const [t1, t2, t3] = M.skyline;
  const tease = (t) => h("a", { class: "tease", href: `#${t.to}` }, h("span", { class: "k" }, t.kicker),
    h("span", { class: `w ${t.colour}` }, t.word), h("span", { class: "x" }, rich(t.text), " ", h("span", { class: "p" }, t.page)));
  const cutout = (cls, t) => h("div", { class: `cutout ${cls}`, "aria-hidden": "true" }, h("img", { src: SHARED + t.cutout, alt: "" }));
  const photo = t3.photo
    ? h("figure", { class: "sky-photo" }, h("img", { src: MEDIA + t3.photo.src, alt: t3.photo.who, style: t3.photo.focus ? { objectPosition: t3.photo.focus } : {} }), h("figcaption", {}, t3.photo.who))
    : h("span", { "aria-hidden": "true" });
  page.append(edbar(), h("header", { class: "mast" },
    h("h1", { class: "nameplate" }, h("span", {}, "Everything is Everything")), h("div", { class: "rule" }),
    h("div", { class: "skyline" }, h("span", { "aria-hidden": "true" }), tease(t1), h("span", { class: "vr" }), tease(t2),
      h("span", { "aria-hidden": "true" }), h("span", { class: "vr" }), tease(t3), photo),
    cutout("left", t1), cutout("mid", t2),
    h("div", { class: "folio" }, h("span", {}, M.folio.left),
      h("span", { class: "mid t" }, `${longDay(e.date)} · ${Math.floor(e.seconds / 60)} minutes · ${M.folio.price}`),
      h("a", { href: `https://www.youtube.com/watch?v=${e.videoId}`, target: "_blank", rel: "noopener" }, M.folio.right))));

  // In brief, ending in a thought for the day
  const briefs = P.brief.flatMap((b, k) => [h("h3", { id: `brief-${k + 1}` }, b.head), h("p", {}, h("span", { class: "sq", "aria-hidden": "true" }), rich(b.text))]);
  const th = P.thought;
  const brief = mod(1, "brief", { "aria-label": "In brief" }, snap("h2", "", "In brief"), text(1, "", briefs), gap(),
    h("aside", { class: "box thought elastic", id: "thought", "data-sizes": "15,16,17,18,19,20,21,22,23,24", "data-pad": "8" }, h("h3", {}, th.label), h("q", {}, th.text),
      h("p", { class: "who" }, withMark(th.who, say(momentOf(th.item))))),
    gap());

  // the lead, cut to the page and continued on page two
  const L = P.lead;
  const body = [h("p", { class: "lead" }, h("span", { class: "dl" }, `${L.dateline}: `), rich(L.body[0])), ...L.body.slice(1).map((s) => para(s))];
  const lead = mod(3, "lead", { id: "lead", "data-cut": L.cut },
    snap("p", "kicker center", L.kicker), snap("h2", "hl xl center", L.head), snap("p", "byline", L.byline),
    ...picture(L.pic), text(2, "", body));

  // the second and third stories
  const S = P.second;
  const second = mod(1, "second", { id: S.id }, snap("p", "label", h("span", {}, S.label)), snap("h2", "hl l", S.head),
    h("p", { class: "deck snap", "data-gap": "8" }, rich(S.deck)), ...picture(S.pic), text(1, "", S.body.map((s) => para(s))),
    gap(), pullQuote(S.quote, "15,16,17,18,19,20"), listen(S.listen));
  const T = P.third;
  const third = mod(1, "third", { id: T.id }, ...picture(T.pic), snap("h2", "hl l", T.head), text(1, "", T.body.map((s) => para(s))),
    listen(T.listen), gap(),
    snap("aside", "box talk", h("h3", {}, "Who talked"),
      h("div", { class: "meter", role: "img", "aria-label": `Amit ${Math.round(D.share[0] * 100)}% and Ajay ${Math.round(D.share[1] * 100)}% of the talking` },
        h("i", { class: "a", style: { width: `${D.share[0] * 100}%` } }), h("i", { class: "b", style: { width: `${D.share[1] * 100}%` } })),
      h("div", { class: "key t" }, h("span", {}, `Amit ${Math.round(D.share[0] * 100)}%`), h("span", {}, `Ajay ${Math.round(D.share[1] * 100)}%`))),
    gap(),
    h("nav", { class: "box inside elastic", "data-pad": "3", "aria-label": "Inside" }, h("h3", {}, "Inside"),
      h("ol", {}, E.index.map((x) => h("li", {}, h("a", { href: `#${x.to}` }, x.label), h("span", { class: "p" }, x.page))))),
    snap("p", "footnote", M.footnote));

  page.append(h("section", { class: "band", "data-fit": "", "data-min": "54" }, brief, lead, second, third));
  page.append(h("section", { class: "band ruled" }, mod(6, "flush", {}, strip())));
  return page;
}

/* The episode, minute by minute: who held the microphone, chapter by chapter, with the moments the
   lead's reel plays marked where they were said. A click anywhere listens from there. */
const Strip = {
  el: null,
  playhead(t) {
    if (!this.el) return;
    if (t == null) return this.el.removeAttribute("data-playing");
    this.el.setAttribute("data-playing", "");
    $(".strip-play", this.el).style.left = `${(t / (D.episode.seconds * 100)) * 100}%`;
  },
};
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const an = (w) => (/^[aeiou]/i.test(w) ? "An" : "A");
function strip() {
  const e = D.episode, dur = e.seconds * 100, pct = (cs) => `${(cs / dur) * 100}%`;
  const free = (t, title) => ({ ep: EP, videoId: e.videoId, clip: [t, t + 6000], at: [t], spk: speakerAt(t + 200), free: true, title });
  const chapters = h("div", { class: "strip-ch" });
  e.chapters.forEach((c, i) => {
    const end = (e.chapters[i + 1]?.start ?? e.seconds) * 100;
    if (end - c.start * 100 < 3000) return;
    chapters.append(h("button", { type: "button", title: c.title, style: { left: pct(c.start * 100), width: pct(end - c.start * 100) },
      onclick: () => Player.play(free(c.start * 100, chapterName(c.title)), null) }, E.chapters?.[c.title] || chapterName(c.title)));
  });
  const turns = h("div", { class: "strip-turns", "aria-hidden": "true" });
  for (const [a, b, s] of D.turns) turns.append(h("i", { "data-s": s, style: { left: pct(a), width: pct(Math.max(b - a, 20)) } }));
  turns.addEventListener("click", (ev) => {
    const r = turns.getBoundingClientRect(), t = ((ev.clientX - r.left) / r.width) * dur;
    Player.play(free(WORDS.t[Math.max(0, upper(WORDS.t, t) - 1)], `from ${clock(t)}`), null);
  });
  const L = E.p1.lead, marks = h("div", { class: "strip-marks" });
  L.reel.forEach((id, k) => {
    const m = momentOf(id);
    if (!m) return;
    // a marker is centred on its moment, but kept whole inside the strip at either end (and stripFit
    // nudges apart markers that would cover each other)
    marks.append(h("button", { type: "button", "data-at": (m.at[0] / dur).toFixed(5), style: { left: `clamp(8.5px, ${pct(m.at[0])}, calc(100% - 8.5px))` }, "aria-label": `${capital(L.reelUnit)} ${k + 1}: ${titleOf(item(id))}, at ${clock(m.at[0])}`,
      onclick: (ev) => Player.play(m, ev.currentTarget) }, String(k + 1)));
  });
  const axis = h("div", { class: "strip-axis t", "aria-hidden": "true" });
  // the first label starts at its tick and the last ends at it, so neither hangs off the strip
  for (let m = 0; m * 6000 < dur; m += dur > 540000 ? 10 : 5) {
    const at = (m * 6000) / dur;
    axis.append(h("span", { style: { left: pct(m * 6000), transform: at < 0.03 ? "none" : at > 0.97 ? "translateX(-100%)" : null } }, `${m}:00`));
  }
  Strip.el = h("div", { class: "strip" }, chapters, turns, marks, axis, h("div", { class: "strip-play" }));
  return [h("h2", { class: "strip-title" }, "The episode, minute by minute"),
    h("p", { class: "strip-sub" }, `Each band is a turn at the microphone. The numbers mark ${L.reelName}. Click a chapter, a number or any minute to listen from there.`),
    Strip.el,
    h("div", { class: "strip-key" }, h("span", { style: { "--c": "var(--amit)" } }, "Amit Varma"), h("span", { style: { "--c": "var(--ajay)" } }, "Ajay Shah"), h("span", { class: "num" }, `${an(L.reelUnit)} ${L.reelUnit}, where it was named`),
      h("span", { class: "howto" }, h("span", { class: "say", "data-s": "0", "aria-hidden": "true" }, h("span", { class: "disc", html: PLAY })), h("span", { class: "say", "data-s": "1", "aria-hidden": "true" }, h("span", { class: "disc", html: PLAY })),
        "Throughout the paper, a play mark is a moment you can hear, in Amit’s voice (red) or Ajay’s (blue)."))];
}

/* ── page two: the argument, chapter by chapter ───────────── */

/* Rows for the sections after the first: two to a row, or three where two would leave one alone. */
function rowsOf(list) {
  const n = list.length;
  if (n <= 3) return n ? [list] : [];
  if (n === 4) return [list.slice(0, 2), list.slice(2)];
  if (n === 5) return [list.slice(0, 2), list.slice(2)];
  return [list.slice(0, 3), ...rowsOf(list.slice(3))];
}

function page2() {
  const P = E.p2, page = h("article", { class: "page", id: "p2", "aria-label": "Page 2" }, runhead(2, "Opinion"));
  page.append(h("section", { class: "band" }, mod(6, "title flush", {}, h("h2", { class: "ptitle" }, P.title), h("p", { class: "pdeck" }, rich(P.deck)))));
  // a chapter's card plays the chapter from its start; a still plays its own section's line (three
  // stills from one chapter all said "Listen from 2:30")
  const art = (x, fixed) => {
    if (!x.art) return [];
    const chapter = x.chapter != null ? { chapter: x.chapter } : null;
    const play = !x.art.card && momentOf(x.quote.item) ? { item: x.quote.item } : chapter || (momentOf(x.quote.item) ? { item: x.quote.item } : null);
    return picture({ ...x.art, focus: x.art.focus || "50% 50%", play, fixed, frame: !!x.art.card });
  };
  const head = (x) => [snap("p", "fnum", x.label), snap("h2", "hl l", x.head), snap("p", "byline left", bylineFor(x))];
  const body = (x, cols) => text(cols, "drop", x.body.map((s) => para(s)));
  const [s1, ...rest] = P.sections, side = P.side;

  // the first section leads the page, with its quote, a picture and a box beside it
  page.append(h("section", { class: "band ruled", "data-fit": "" },
    mod(4, "", { id: s1.id }, ...art(s1), ...head(s1), body(s1, 3)),
    mod(2, "", {}, pullQuote(side.quote, "19,20,21,22,23,24,25,26"), gap(),
      ...(side.photo ? picture({ ...side.photo, focus: side.photo.focus || "50% 22%" }) : []),
      Object.assign(snap("aside", "box tint", h("h3", {}, side.box.title), h("p", {}, rich(side.box.text))), { id: "side" }))));
  for (const row of rowsOf(rest)) {
    const span = 6 / row.length, cols = row.length === 1 ? "4,3" : row.length === 2 ? "2" : "1";
    page.append(h("section", { class: "band ruled", "data-fit": "" }, ...row.map((x) => mod(span, "", { id: x.id },
      ...art(x, !!x.portraits), ...head(x),
      x.portraits ? [portraits(x.portraits, [0.75, 1.1, 1.5], 2), gap()] : null,
      body(x, cols), gap(), pullQuote(x.quote, "17,19,21,23,25,27")))));
  }
  // the lead's continuation, from page one
  page.append(h("section", { class: "band ruled", "data-fit": "" },
    mod(6, "cont", { id: "from1" }, snap("p", "from", h("a", { href: "#lead" }, "From page 1")), snap("h2", "hl m", P.from1.head),
      // one wide column is the last resort, for a continuation too short to divide evenly
      text("3,2,4,1", "", []), gap(), pullQuote(P.cont.quote, "18,20,22,24,26"))));
  return page;
}

/* Who carried a section: its chapter's voices (one name if one held 60% of it, else both, the
   larger first), or the voice of its quote where it has no chapter. */
function bylineFor(x) {
  const c = D.episode.chapters, ch = x.chapter;
  if (ch == null || !c[ch]) return NAMES[momentOf(x.quote.item)?.spk ?? 2];
  const a = c[ch].start * 100, b = (c[ch + 1]?.start ?? D.episode.seconds) * 100;
  const talk = [0, 0, 0];
  for (const [s, e, k] of D.turns) talk[k] += Math.max(0, Math.min(e, b) - Math.max(s, a));
  const [amit, ajay] = talk, top = amit >= ajay ? 0 : 1;
  return Math.max(amit, ajay) / (amit + ajay) >= 0.6 ? NAMES[top] : `${NAMES[top]} and ${NAMES[1 - top]}`;
}

/* ── page three: stories ──────────────────────────────────── */

function page3() {
  const P = E.p3, page = h("article", { class: "page", id: "p3", "aria-label": "Page 3" }, runhead(3, "Features"));
  page.append(h("section", { class: "band" }, mod(6, "title flush", {}, h("h2", { class: "ptitle" }, P.title), h("p", { class: "pdeck" }, rich(P.deck)))));
  const story = (s, span, cols) => {
    const it = item(s.item);
    return mod(span, "", { id: s.id },
      ...picture(s.pic),
      snap("p", "kicker", s.kicker), snap("h2", "hl l", s.head), snap("p", "byline left", `Told by ${it.teller}`),
      text(cols, "drop", s.body.map((x) => para(x))),
      gap(),
      s.why ? h("aside", { class: "box tint why elastic", "data-pad": "10" }, h("h3", {}, "Why it stays with you"), h("p", {}, rich(s.why))) : pullQuote(s.quote),
      s.postscript ? h("p", { class: "ps snap", "data-gap": "0" }, h("b", {}, "Postscript"), rich(s.postscript)) : null);
  };
  const S = P.stories;
  // four stories make two rows, the first led by a wide one; three stand side by side
  const rows = S.length === 4 ? [[[S[0], 4, "3"], [S[1], 2, "1"]], [[S[2], 3, "2"], [S[3], 3, "2"]]]
    : S.length === 3 ? [[[S[0], 2, "1"], [S[1], 2, "1"], [S[2], 2, "1"]]]
      : [S.map((s) => [s, 6 / S.length, S.length === 1 ? "4,3" : "2"])];
  for (const row of rows) page.append(h("section", { class: "band ruled", "data-fit": "" }, ...row.map(([s, span, cols]) => story(s, span, cols))));
  page.append(h("section", { class: "band ruled", id: "numbers" }, mod(6, "flush", {}, snap("p", "label", h("span", {}, "By the numbers")),
    h("div", { class: "numbers" }, P.numbers.map((n, k) => {
      const m = momentOf(n.ref);
      return h("div", { class: "cell", id: `num-${k + 1}` }, h("span", { class: "fig t" }, n.figure), h("span", { class: "what" }, rich(n.text)), m ? say(m, `${FIRST[m.spk]} · ${clock(m.at[0])}`) : null);
    })))));
  return page;
}

/* ── page four: books, laughs, quiz ───────────────────────── */

function page4() {
  const P = E.p4, page = h("article", { class: "page", id: "p4", "aria-label": "Page 4" }, runhead(4, "Books & laughs"));
  const shelf = E.shelf.flatMap((b) => {
    const m = momentOf(b.id);
    // the cover beside a book, a film, a record: a float exactly four lines tall, so the entry beside
    // it stays on the grid; it links where the title's link goes, for the eye only (the link is below).
    // A cover near a column's foot is pushed whole to the next column (Chrome splits no float), away
    // from its title: the engine treats that as a fault, and accepts it only if nothing else fits.
    const cover = b.cover ? h(b.url ? "a" : "span", { class: "cover", style: { "--r": b.cover.r }, "aria-hidden": "true",
      ...(b.url ? { href: b.url, target: "_blank", rel: "noopener", tabindex: "-1" } : {}) },
    h("img", { class: "art", src: COVERS + b.cover.src, alt: "", loading: "lazy", decoding: "async" })) : null;
    return [h("h4", { class: "bk air", id: `r-${b.id}` }, cover, b.title),
      h("p", {}, h("span", { class: "by" }, [b.creator, b.type].filter(Boolean).join(" · ")), ". ", rich(b.why)),
      // real spaces between the parts, so a narrow phone can wrap the line between them
      // its meta line is the shelf's finest lever: the last few may be left out on a desktop to divide
      // the columns evenly (a short shelf found no even setting without it); phones show them all
      h("p", { class: "meta opt" }, m ? say(m, `${FIRST[m.spk]} at ${clock(m.at[0])}`) : h("span", { class: "nb" }, "In the show notes"),
        b.episodes > 1 ? [" ", h("span", { class: "sep" }, "|"), " ", h("span", { class: "nb" }, `In ${b.episodes} episodes`)] : null,
        // one of this show's own episodes is an edition here: the link goes to it, not to the video
        b.edition ? [" ", h("span", { class: "sep" }, "|"), " ", h("a", { class: "nb", href: `../${b.edition}/` }, `Read Edition ${b.edition} →`)]
          : b.url ? [" ", h("span", { class: "sep" }, "|"), " ", h("a", { class: "nb", href: b.url, target: "_blank", rel: "noopener" }, `${domain(b.url)} ↗`)] : null)];
  });
  const funny = E.laughs.filter((j) => j.type === "humor"), refs = E.laughs.filter((j) => j.type !== "humor");
  // past the first four jokes, a laugh line is one a sub-editor may cut to fit, the name-drops first
  const laughList = [...funny.map((j, k) => h("p", { class: k >= 4 ? "opt" : null, id: `j-${j.id}` }, withMark(j.text, say(momentOf(j.id))))), refs.length ? h("h4", {}, P.laughs.refsTitle) : null,
    ...refs.map((j) => h("p", { class: "opt", id: `j-${j.id}` }, withMark(j.text, say(momentOf(j.id)))))].filter(Boolean);
  const O = P.laughs.overheard;
  const laughText = text(1, "laughs", laughList);
  laughText.dataset.optmax = "8";   // up to eight lines may go, where the default lever stops at three
  const laughs = (span) => mod(span, "", { id: "laughs" }, h("h2", { class: "hl l snap", "data-gap": "6" }, P.laughs.title), laughText, gap(),
    Object.assign(pullQuote({ text: O.text, item: O.item, who: O.who }, "16,17,18,19,20,21,22,23,24,25,26", "Overheard", 24), { id: "overheard" }));
  const books = (span, cols) => mod(span, "", { id: "shelf" }, snap("h2", "hl l", P.shelf.title), h("p", { class: "pdeck snap", "data-gap": "8" }, P.shelf.deck),
    P.shelf.portraits?.length ? [portraits(P.shelf.portraits, [0.55, 0.9, 1.4], 3), gap()] : null, text(cols, "shelf", shelf));
  // a long shelf takes the page's width, and the laugh lines join the quiz
  const wide = P.shelf.wide;
  // a short shelf reads, and divides, better in two columns than three
  page.append(h("section", { class: "band", "data-fit": "" }, ...(wide ? [books(6, "4,5,3")] : [books(4, E.shelf.length <= 12 ? "2,3" : "3,2"), laughs(2)])));
  page.append(crossword());
  const quizItems = P.quiz.map((q, k) => h("p", {}, h("span", { class: "qn" }, `${k + 1}.`), rich(q.q)));
  const answers = h("ol", { class: "answers", tabindex: "0", "aria-label": "The answers, printed upside down. Point at them, or press Enter, to turn them over" },
    P.quiz.map((q, k) => h("li", {}, h("b", {}, `${k + 1}.`), withMark(q.a, say(momentOf(q.item))))));
  answers.addEventListener("click", (ev) => { if (!ev.target.closest(".say")) answers.classList.toggle("up"); });
  answers.addEventListener("keydown", (ev) => { if (ev.target === answers && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); answers.classList.toggle("up"); } });
  const [word, ...terms] = P.glossary;
  const lower = (s) => s[0].toLowerCase() + s.slice(1);
  const span = wide ? 2 : 3;
  page.append(h("section", { class: "band ruled", "data-fit": "" }, wide ? laughs(2) : null,
    mod(span, "", { id: "quiz" }, snap("h2", "hl l", "Quiz"), h("p", { class: "pdeck snap", "data-gap": "8" }, "Answer out loud first: recalling it is what makes it stay."),
      text(1, "quiz", quizItems), gap(),
      h("aside", { class: "box elastic", "data-pad": "14" }, h("p", { class: "answers-label" }, "Answers, upside down"), answers)),
    mod(span, "", { id: "gloss" }, h("h2", { class: "hl l snap", "data-gap": "6" }, "Word watch"),
      Object.assign(pullQuote({ text: `${word.term}: ${lower(word.def)}`, item: word.item, who: "Word of the day" }, "18,20,22,24,26,28,30,32", null, 20), { id: "word" }), gap(),
      text(wide ? "1" : "2,1", "gloss", terms.map((g, k) => h("p", { id: `g-${k + 1}` }, h("b", {}, g.term), ": ", withMark(g.def, g.item ? say(momentOf(g.item)) : null)))))));
  page.append(h("footer", { class: "colophon" }, P.credits), nextup());
  return page;
}

/* The foot of the last page: the editions either side of this one, by their headlines. */
function nextup() {
  const N = E.nav;
  if (!N.prev && !N.next) return null;
  const card = (x, cls, label) => (x
    ? h("a", { class: `nx ${cls}`, href: `../${x.n}/` }, h("span", { class: "k" }, `${label} · Episode ${x.n}`), h("span", { class: "h" }, x.head))
    : h("span", { class: `nx ${cls}` }));
  return h("nav", { class: "nextup", "aria-label": "More editions" }, card(N.prev, "prev", "The edition before"),
    h("a", { class: "nx all", href: "../" }, h("span", { class: "k" }, "The archive"), h("span", { class: "h" }, `All ${N.total} editions`)),
    card(N.next, "next", "The next edition"));
}

/* ── the crossword ────────────────────────────────────────── */

/* Every answer was said in the episode. Solve a clue and a play mark appears beside it: the moment
   the answer came up, in the hosts' voices. Progress is kept in this browser. */
function crossword() {
  const X = E.crossword, KEY = `eie.cw.${EP}`, saved = store.get(KEY, {});
  const at = new Map();
  for (const e of X.entries) {
    e.cells = [];
    for (let i = 0; i < e.answer.length; i++) {
      const r = e.dir === "a" ? e.r : e.r + i, c = e.dir === "a" ? e.c + i : e.c, k = `${r},${c}`;
      const cell = at.get(k) || { r, c, k, ch: e.answer[i] };
      cell[e.dir] = e;
      if (i === 0) cell.n = e.n;
      at.set(k, cell);
      e.cells.push(cell);
    }
  }
  const across = X.entries.filter((e) => e.dir === "a").sort((a, b) => a.n - b.n);
  const down = X.entries.filter((e) => e.dir === "d").sort((a, b) => a.n - b.n);
  const name = (e) => `${e.n} ${e.dir === "a" ? "across" : "down"}`;
  let cur = { cell: null, dir: "a" };

  const grid = h("div", { class: "cw-grid", style: { "--w": X.w, "--h": X.h }, role: "group", "aria-label": `Crossword grid, ${X.w} squares by ${X.h}` });
  for (const cell of at.values()) {
    const entries = [cell.a, cell.d].filter(Boolean);
    cell.input = h("input", { class: "cw-in", type: "text", maxlength: "2", autocomplete: "off", autocorrect: "off", autocapitalize: "characters", spellcheck: "false",
      "aria-label": entries.map((e) => `${name(e)}, letter ${e.cells.indexOf(cell) + 1} of ${e.answer.length}`).join("; ") });
    cell.input.value = saved[cell.k] || "";
    // every line drawn once: a square draws its own top and left edges, and its right and bottom edges
    // only where no square follows (two squares each drawing a whole outline overlapped by turns)
    const edge = [!at.has(`${cell.r},${cell.c + 1}`) && "r", !at.has(`${cell.r + 1},${cell.c}`) && "b"].filter(Boolean).join(" ");
    cell.box = h("div", { class: `cw-cell ${edge}`.trim(), style: { gridRow: cell.r + 1, gridColumn: cell.c + 1 } },
      cell.n ? h("span", { class: "cw-n", "aria-hidden": "true" }, String(cell.n)) : null, cell.input);
    grid.append(cell.box);
  }
  const bar = h("p", { class: "cw-bar", "aria-live": "polite" }, "Choose a square, or a clue, to begin.");
  const tally = h("span", { class: "cw-tally t" });
  const clueOf = new Map();
  const clue = (e) => {
    // the letter count travels with the clue's last word, and the mark with the count
    const p = h("p", { class: "cw-clue", "data-k": `${e.n}${e.dir}` }, h("b", {}, String(e.n)), " ", e.clue);
    bind(p, h("span", { class: "nb" }, " ", h("span", { class: "enum" }, `(${e.enum})`), say(momentOf(e.ref), null, `Hear where the answer to ${name(e)} came up`)));
    p.addEventListener("click", (ev) => { if (!ev.target.closest(".say")) go(e.cells.find((c) => !c.input.value) || e.cells[0], e.dir); });
    clueOf.set(e, p);
    return p;
  };
  const clues = text(1, "clues", [h("h4", { class: "keep" }, "Across"), ...across.map(clue), h("h4", { class: "keep" }, "Down"), ...down.map(clue)]);

  const save = () => store.set(KEY, Object.fromEntries([...at.values()].filter((c) => c.input.value).map((c) => [c.k, c.input.value])));
  const solved = (e) => e.cells.every((c) => c.input.value === c.ch);
  const mark = () => {
    let n = 0;
    for (const e of X.entries) { const s = solved(e); clueOf.get(e).classList.toggle("solved", s); n += s; }
    tally.textContent = n === X.entries.length ? `All ${n} solved` : `${n} of ${X.entries.length} solved`;
  };
  const entryAt = (cell, dir) => cell[dir] || cell[dir === "a" ? "d" : "a"];
  function show() {
    for (const c of at.values()) c.box.classList.remove("word", "on");
    for (const p of clueOf.values()) p.classList.remove("on");
    if (!cur.cell) return;
    const e = entryAt(cur.cell, cur.dir);
    cur.dir = e.dir;
    e.cells.forEach((c) => c.box.classList.add("word"));
    cur.cell.box.classList.add("on");
    clueOf.get(e).classList.add("on");
    put(bar, h("b", {}, `${name(e)}`), `  ${e.clue} (${e.enum})`);
  }
  function go(cell, dir) {
    if (!cell) return;
    cur = { cell, dir: dir || cur.dir };
    cell.input.focus({ preventScroll: true });
    show();
  }
  const step = (cell, dir, by) => {
    const e = entryAt(cell, dir), i = e.cells.indexOf(cell);
    return e.cells[i + by] || null;
  };
  const near = (cell, dr, dc) => {
    for (let r = cell.r + dr, c = cell.c + dc; r >= 0 && c >= 0 && r < X.h && c < X.w; r += dr, c += dc) {
      const hit = at.get(`${r},${c}`);
      if (hit) return hit;
    }
    return null;
  };
  for (const cell of at.values()) {
    const input = cell.input;
    input.addEventListener("pointerdown", (ev) => {
      if (cur.cell === cell && cell.a && cell.d) { ev.preventDefault(); cur.dir = cur.dir === "a" ? "d" : "a"; show(); input.focus({ preventScroll: true }); }
    });
    input.addEventListener("focus", () => { if (cur.cell !== cell) { cur.cell = cell; if (!cell[cur.dir]) cur.dir = cell.a ? "a" : "d"; } show(); });
    input.addEventListener("input", () => {
      const v = (input.value.match(/[a-z]/gi) || []).pop()?.toUpperCase() || "";
      input.value = v;
      cell.box.classList.remove("wrong");
      save(); mark();
      if (v) go(step(cell, cur.dir, 1) || cell, cur.dir);
    });
    input.addEventListener("keydown", (ev) => {
      const k = ev.key;
      if (k === "Backspace" && !input.value) { ev.preventDefault(); const prev = step(cell, cur.dir, -1); if (prev) { prev.input.value = ""; save(); mark(); go(prev); } }
      else if (k.startsWith("Arrow")) {
        ev.preventDefault();
        const [dr, dc] = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
        const dir = dr ? "d" : "a";
        if (cur.dir !== dir && cell[dir]) { cur.dir = dir; show(); } else go(near(cell, dr, dc), dir);
      } else if (k === "Enter") { ev.preventDefault(); if (cell.a && cell.d) { cur.dir = cur.dir === "a" ? "d" : "a"; show(); } }
      else if (k === "Tab") {
        ev.preventDefault();
        const order = [...across, ...down], e = entryAt(cell, cur.dir), i = order.indexOf(e);
        const next = order[(i + (ev.shiftKey ? -1 : 1) + order.length) % order.length];
        go(next.cells.find((c) => !c.input.value) || next.cells[0], next.dir);
      } else if (k === "Escape") { input.blur(); }
    });
  }
  const button = (label, f) => h("button", { type: "button", class: "cw-btn", onclick: f }, label);
  const controls = h("div", { class: "box cw-controls elastic", "data-pad": "14" },
    h("div", { class: "cw-row" },
      button("Check", () => { for (const c of at.values()) c.box.classList.toggle("wrong", !!c.input.value && c.input.value !== c.ch); }),
      button("Reveal this word", () => { if (!cur.cell) return; const e = entryAt(cur.cell, cur.dir); e.cells.forEach((c) => { c.input.value = c.ch; c.box.classList.remove("wrong"); }); save(); mark(); }),
      button("Start again", () => { for (const c of at.values()) { c.input.value = ""; c.box.classList.remove("wrong"); } save(); mark(); go(across[0].cells[0], "a"); }),
      tally));
  const how = h("aside", { class: "box tint elastic", "data-pad": "14" }, h("h3", {}, "How to play"),
    h("p", {}, "Tap a square and type. Tap it again, or press Enter, to turn from across to down; Tab jumps to the next clue. Solve a clue and its play mark appears: the moment the answer was said."));
  mark();
  return h("section", { class: "band ruled", "data-fit": "", id: "crossword" },
    mod(4, "", {}, snap("h2", "hl l", "The Everything Crossword"), h("p", { class: "pdeck snap", "data-gap": "8" }, "Every answer was said in this episode."),
      h("div", { class: "cw-wrap snap", "data-gap": "10" }, bar, grid), controls),
    mod(2, "", { id: "clues" }, clues, gap(), how));
}

/* ── the typesetting engine ───────────────────────────────── */

const TRACKS = [0, -0.004, 0.004, -0.008, 0.008, -0.012, 0.012, -0.016, 0.016];   // letter-spacing, em, the least first
const SPACES = [0, 0.06, -0.06];   // word-spacing, em: a second, finer way to move a line break
const rows = (px) => Math.round(px / LH);
function range(a, b) { const out = []; for (let x = a; x <= b; x++) out.push(x); return out; }

/* A headline with a word wider than its column is set smaller, as a sub-editor would, until the
   word fits: "macroeconomists" in one narrow column ran off the page. Its line height, and so the
   grid, stays as it was. */
function fitHeads(root) {
  for (const el of $$(".hl, .ptitle, .tease .w, .tease .k, .numbers .fig", root)) {
    el.style.fontSize = "";
    el.style.fontStretch = "";
    const over = () => el.scrollWidth > el.clientWidth + 1;
    // a teaser's word condenses before it shrinks (the face goes down to 62% wide): "Beethoven" keeps
    // more of its size beside "Guitar" that way
    if (el.matches(".tease .w")) for (let s = 70; over() && s >= 62; s -= 2) el.style.fontStretch = `${s}%`;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    const least = el.closest(".tease") ? 10 : 16;   // a phone's teaser starts at 15px
    while (over() && fs > least) {
      fs -= fs > 20 ? 2 : 1;
      el.style.fontSize = `${fs}px`;
    }
  }
}

/* The minute-by-minute strip at its width. On a phone the axis has room for every other label, or every
   fourth, and two moments a minute apart would put one number over the other: the labels that would
   touch are left out evenly, and the markers are nudged apart in time order, kept inside the strip. */
function stripFit(root) {
  for (const ax of $$(".strip-axis", root)) {
    const spans = [...ax.children], W = ax.clientWidth;
    for (let k = 1; k <= 8; k *= 2) {
      const shown = spans.filter((s, i) => { s.hidden = i % k !== 0; return !s.hidden; });
      // each label centred on its tick, but kept whole inside the strip: "50:00" of a 52-minute
      // episode is near enough the end to hang off a phone's strip
      for (const s of shown) {
        const x = s.offsetLeft, wl = s.offsetWidth, L = Math.min(Math.max(x - wl / 2, 0), W - wl);
        s.style.transform = `translateX(${(L - x).toFixed(1)}px)`;
      }
      const r = shown.map((s) => s.getBoundingClientRect());
      if (r.every((q, i) => !i || q.left >= r[i - 1].right + 6)) break;
    }
  }
  for (const row of $$(".strip-marks", root)) {
    const w = row.clientWidth, R = 8.5, gap = 2 * R + 2;
    const ms = [...row.children].sort((a, b) => a.dataset.at - b.dataset.at);
    if (!w || !ms.length) continue;
    const x = ms.map((b) => b.dataset.at * w);
    for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i], i ? x[i - 1] + gap : R);
    for (let i = x.length - 1; i >= 0; i--) x[i] = Math.min(x[i], i < x.length - 1 ? x[i + 1] - gap : w - R);
    ms.forEach((b, i) => { b.style.left = `${x[i].toFixed(1)}px`; });
  }
}

/* A crossword's squares, as large as its column allows (up to 40px), each a whole number of the screen's
   own pixels, and its lines a whole number thick. On a phone at three pixels to the point, a square of
   25.87 points was 77.6 pixels: some squares came out 77 and some 78, some lines thicker than others, and
   rows that didn't quite meet. A desktop keeps whole points as before (the band it sits in is fitted to
   them), snapped to pixels only where a screen's ratio isn't whole. */
function cwFit(root) {
  const dpr = devicePixelRatio || 1, article = document.documentElement.classList.contains("article");
  // a length Chrome keeps exactly (it lays out in 64ths of a point): otherwise each square is a hair
  // off, and across fifteen squares the hairs add up to nearly a pixel
  const exact = (pt) => Math.abs(pt * 64 - Math.round(pt * 64)) < 1e-6;
  for (const g of $$(".cw-grid", root)) {
    const w = +g.style.getPropertyValue("--w"), room = g.parentElement.clientWidth;
    if (!w || !room) continue;
    const pts = article ? room / w : Math.floor(Math.min(40, room / w));
    let px = Math.floor(pts * dpr);
    for (let k = px; k >= Math.floor(px * 0.85); k--) if (exact(k / dpr)) { px = k; break; }
    const cell = px / dpr;
    g.style.setProperty("--cell", `${cell}px`);
    g.style.setProperty("--line", `${Math.max(1, Math.round(dpr)) / dpr}px`);
    // on a phone the grid starts at the column's edge (a whole pixel), moved in by whole pixels to centre it
    g.style.marginLeft = article ? `${Math.floor(((room - cell * w) / 2) * dpr) / dpr}px` : "";
  }
}

/* Pad a block down to the next line, keeping at least data-gap pixels of white below its ink;
   give a fixed picture its natural crop in whole lines. */
function snapAll(root) {
  fitHeads(root);
  stripFit(root);
  // a chapter label that cannot be read whole keeps only its rule; its name is in its tooltip
  for (const b of $$(".strip-ch button", root)) b.classList.toggle("tight", b.scrollWidth > b.clientWidth + 1);
  cwFit(root);
  for (const el of $$(".pic[data-fixed]", root)) el.style.height = `${Math.round((el.clientWidth * +el.dataset.r.split(",")[1]) / LH) * LH}px`;
  for (const el of $$(".snap", root)) {
    el.style.paddingBottom = "";
    const base = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    const h0 = el.getBoundingClientRect().height, g = +el.dataset.gap || 0;
    const extra = Math.ceil((h0 + g) / LH - 0.02) * LH - h0;
    if (extra > 0.01) el.style.paddingBottom = `${base + extra}px`;
  }
}

const Fit = {
  report: [],
  prof: {},
  time(k, f) { const t0 = performance.now(); const r = f(); this.prof[k] = Math.round((this.prof[k] || 0) + performance.now() - t0); return r; },
  /* Page one is set first and shown at once; the inside pages are set in the idle moments after,
     each appearing as it is ready, long before a reader scrolls to it. `gen` stops a run that a
     newer one (a resize) has replaced. */
  async run(onFirst) {
    const t0 = performance.now(), gen = ++this.gen;
    this.report = [];
    const pages = $$(".page");
    // between bands, let the browser paint and answer the reader: a whole page set in one go
    // held up the first paint by two seconds
    const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    this.bandms = [];
    for (const [i, page] of pages.entries()) {
      snapAll(page);
      for (const [j, band] of $$(".band[data-fit]", page).entries()) {
        band.dataset.key = `${page.id}.${j}`;
        if (i) await breathe();
        if (gen !== this.gen) return;
        const b0 = performance.now();
        this.band(band);
        this.bandms.push(`${page.id}:${Math.round(performance.now() - b0)}`);
      }
      page.classList.add("set");
      if (i === 0) {
        document.documentElement.dataset.firstms = Math.round(performance.now() - t0);
        onFirst?.();
        requestAnimationFrame(() => performance.mark("eie:painted"));
      }
    }
    const short = this.report.filter((r) => !r.ok);
    document.documentElement.dataset.fit = short.length ? `short:${short.map((r) => r.id).join(",")}` : "ok";
    document.documentElement.dataset.fitms = Math.round(performance.now() - t0);
  },
  gen: 0,

  /* Try the band's depths, kindest first, until every story in it fits; a depth where one story
     cannot (say every fit leaves a crosshead at a column's foot) is given up, cuts and all. */
  band(b) {
    const cont = $(".mod.cont", b);
    if (cont && !$(".text", cont).children.length) { b.remove(); return; }
    // look a little, then harder, then everywhere: most bands fit on the first look
    let models = [...b.children].filter((m) => m.classList.contains("mod")).map((m) => this.model(m, 6));
    if (this.tryDepths(b, models)) return;
    models = models.map((mm) => this.model(mm.el, 24));
    if (this.tryDepths(b, models)) return;
    models = models.map((mm) => this.model(mm.el, Infinity));
    if (this.tryDepths(b, models)) return;
    const depths = this.depths(b, models);
    const T = depths[0] ?? this.floor(b, models);   // nothing fits exactly: set the kindest depth, and say so
    b.dataset.depth = T;
    for (const mm of models) {
      const ok = !!this.apply(mm, T);
      if (!ok) mm.el.dataset.fit = "short";
      this.report.push({ id: mm.el.id || mm.el.className, band: b.dataset.key, T, ok, why: mm.why, ...this.range(mm) });
    }
  },

  /* For a band that could not be fitted: how deep each story can be made, in lines, and how many
     words a line of its text holds, so a sub-editor knows what to cut or add. */
  range(mm) {
    const pic = mm.pic ? [mm.picL.min, mm.picL.max] : [0, 0];
    const hs = mm.box ? mm.boxO.map((o) => o.h) : [0];
    const rs = !mm.text ? [0] : mm.cut ? [6, 999] : mm.textO.map((o) => o.L / o.n);
    const words = mm.text ? mm.text.textContent.trim().split(/\s+/).length : 0;
    const L = mm.text && mm.textO[0] ? mm.textO[0].L : null;
    return { range: rs.length ? [mm.F + pic[0] + Math.min(...hs) + Math.min(...rs), mm.F + pic[1] + Math.max(...hs) + Math.max(...rs)] : null,
      cols: mm.n, wpl: L ? +(words / L).toFixed(1) : null, words };
  },

  tryDepths(b, models) {
    const depths = this.time("depths", () => this.depths(b, models));
    for (const T of depths) {
      const undos = [];
      for (const mm of models) {
        const undo = this.apply(mm, T);
        if (!undo) break;
        undos.push(undo);
      }
      if (undos.length === models.length) {
        b.dataset.depth = T;
        for (const mm of models) this.report.push({ id: mm.el.id || mm.el.className, T, ok: true });
        return true;
      }
      undos.reverse().forEach((u) => u());
    }
    return false;
  },

  /* What a story is made of: its fixed lines, and the parts that can give. */
  model(m, limit = 6) {
    const kids = [...m.children];
    const pic = kids.find((k) => k.classList.contains("elastic") && k.classList.contains("pic"));
    const box = kids.find((k) => k.classList.contains("elastic") && !k.classList.contains("pic"));
    const txt = kids.find((k) => k.classList.contains("text"));
    const ns = txt ? txt.dataset.cols.split(",").map(Number) : [0];   // a text may offer several column counts, the first preferred
    const mm = { el: m, pic, box, text: txt, ns, n: ns[0], cut: m.dataset.cut };
    if (pic) {
      const w = pic.clientWidth, [a, nat, z] = pic.dataset.r.split(",").map(Number);
      mm.picL = { min: Math.ceil((w * a) / LH), nat: Math.round((w * nat) / LH), max: Math.floor((w * z) / LH) };
      pic.style.height = `${mm.picL.nat * LH}px`;
    }
    if (box) mm.boxO = this.time("boxes", () => this.boxOptions(box));
    const other = (pic ? pic.offsetHeight : 0) + (box ? box.offsetHeight : 0) + (txt ? txt.offsetHeight : 0);
    mm.F = rows(m.offsetHeight - other);
    if (txt) mm.textO = this.time("text", () => this.options(mm, limit));
    return mm;
  },

  /* The ways a text can be set so that its columns come out even: crossheads kept or dropped
     (which is what crossheads are for), a hair of letter- and word-spacing, and the column counts
     it allows. They are tried least-disturbed first, each measured in one column of its measure
     and, if its lines divide evenly, set in columns and kept only if every column ends flush and
     none starts or ends on a crosshead. A text's columns break the same way whatever its picture
     and boxes do, so this is done once per text. `limit` stops the search once enough lengths are
     found; a band that cannot be fitted asks again without one. */
  options(mm, limit) {
    const t = mm.text, s = t.style, w = t.clientWidth;
    const heads = $$(":scope > h4:not(.bk):not(.keep)", t), k = heads.length;
    const drops = k <= 3 ? range(0, (1 << k) - 1).map((bits) => heads.map((_, i) => i).filter((i) => bits & (1 << i)))
      : [[], ...heads.map((_, i) => [i]), heads.map((_, i) => i)];
    // paragraphs the copy marks as optional ("~ "), left out from the last one back: a whole
    // paragraph moves a column by lines, where spacing moves it by one
    const opts = $$(":scope > p.opt", t), ods = range(0, Math.min(opts.length, +t.dataset.optmax || 3));
    const omit = (od) => opts.forEach((x, i) => x.classList.toggle("dropped", i >= opts.length - od));
    // a listing's titles carry a line of air each; the last few may give theirs up, a line at a time
    // (the shelf found no even setting without it: a title at a column's foot, or lines that wouldn't divide)
    const airs = $$(":scope > .air", t).slice(1), tights = range(0, Math.min(airs.length, 3));
    const tighten = (k) => airs.forEach((x, i) => x.classList.toggle("tight", i >= airs.length - k));
    // a story with a drop cap may also take a two-line cap, or none, if its lines will not divide
    const caps = t.classList.contains("drop") || t.dataset.cap ? ["drop", "drop2", "nocap"] : [null];
    t.dataset.cap = caps[0] || "";
    const cap = (k) => { if (k) { t.classList.remove("drop", "drop2", "nocap"); t.classList.add(k); } };
    const measure = (c) => {
      cap(c.cap);
      heads.forEach((x, i) => x.classList.toggle("dropped", c.drop.includes(i)));
      omit(c.od || 0);
      tighten(c.tight || 0);
      s.columnCount = "1"; s.height = "auto"; s.width = `${(w - (c.n - 1) * GUT) / c.n}px`;
      s.letterSpacing = c.t ? `${c.t}em` : ""; s.wordSpacing = c.ws ? `${c.ws}em` : "";
      const raw = t.getBoundingClientRect().height / LH;
      return Math.abs(raw - Math.round(raw)) < 0.05 ? Math.round(raw) : null;
    };
    const done = () => { cap(caps[0]); heads.forEach((x) => x.classList.remove("dropped")); omit(0); tighten(0); Object.assign(s, { letterSpacing: "", wordSpacing: "", width: "", columnCount: "", height: "" }); };
    if (mm.cut) {   // a story that may be cut needs only its full length
      const L = measure({ n: mm.n, drop: [], od: 0, t: 0, ws: 0, cap: caps[0] });
      done();
      return [{ n: mm.n, drop: [], od: 0, t: 0, ws: 0, cap: caps[0], L: L ?? 0 }];
    }
    // A text is laid out once for each measure, cap and spacing; what a crosshead, an optional
    // paragraph or a title's air takes away is whole lines, so every other setting's length is
    // arithmetic. (Laying out every setting, a shelf of listings took sixteen seconds to set.)
    const bases = new Map();
    const lines = (el) => Math.round(el.getBoundingClientRect().height / LH);
    const predict = (c) => {
      const key = `${c.n}|${c.cap}|${c.ws}|${c.t}`;
      if (!bases.has(key)) {
        const L = measure({ ...c, drop: [], od: 0, tight: 0 });
        bases.set(key, L == null ? null : { L, heads: heads.map(lines), opts: opts.map(lines) });
      }
      const b = bases.get(key);
      if (!b) return null;
      let L = b.L - c.tight;   // a tightened title gives up its one line of air
      for (const i of c.drop) L -= b.heads[i];
      for (let i = opts.length - c.od; i < opts.length; i++) L -= b.opts[i];
      return L;
    };
    const cands = [];
    for (const n of mm.ns) for (const k of caps) for (const drop of drops) for (const od of ods) for (const tight of tights) for (const ws of SPACES) for (const tr of TRACKS) cands.push({ n, cap: k, drop, od, tight, ws, t: tr });
    cands.sort((a, b) => mm.ns.indexOf(a.n) - mm.ns.indexOf(b.n) || caps.indexOf(a.cap) - caps.indexOf(b.cap) || a.drop.length - b.drop.length || a.od - b.od || a.tight - b.tight || Math.abs(a.ws) - Math.abs(b.ws) || Math.abs(a.t) - Math.abs(b.t));
    const found = new Map(), spare = new Map(), checks = new Map();
    // checks in real columns, the costly part, are budgeted for each column count: a count that cannot
    // work (a shelf's covers pushed into a fourth column) must not use up the next count's turn
    const most = Number.isFinite(limit) ? limit * 6 : 240;
    for (const c of cands) {
      if ((checks.get(c.n) || 0) >= most) continue;   // this column count has had its turn: not even measured
      const L = predict(c);
      if (L == null || L <= 0 || L % c.n) continue;
      const key = `${c.n}|${c.cap}|${c.drop}|${c.od}|${c.tight}|${L}`;
      if (found.has(key)) continue;
      checks.set(c.n, (checks.get(c.n) || 0) + 1);
      s.width = "";   // back to the full measure, to be set in columns
      this.set(mm, { r: L / c.n, t: c.t, ws: c.ws, drop: c.drop, od: c.od, tight: c.tight, n: c.n, cap: c.cap });
      const ok = this.columns(mm, true);
      if (ok === true) found.set(key, { ...c, L });
      else if (ok === "cover apart" && spare.size < limit) spare.set(key, { ...c, L });   // only if nothing better
      if (found.size >= limit) break;
    }
    done();
    return found.size ? [...found.values()] : [...spare.values()];
  },

  /* The depths a box can take: each type size, then up to data-pad lines of air around it. */
  boxOptions(box) {
    const sizes = (box.dataset.sizes || "").split(",").filter(Boolean).map(Number);
    const pad = +box.dataset.pad || 4, out = [];
    for (const size of sizes.length ? sizes : [null]) {
      if (size) box.style.setProperty("--qs", `${size}px`);
      box.style.height = "";
      const base = Math.ceil(box.getBoundingClientRect().height / LH - 0.02);
      for (let p = 0; p <= pad; p++) out.push({ size, h: base + p, pad: p });
    }
    if (sizes.length) box.style.setProperty("--qs", `${sizes[0]}px`);
    box.style.height = `${out[0].h * LH}px`;
    return out;
  },

  /* Every way this story can be exactly T lines deep, best first: no tracking, the picture near
     its natural crop, the least air in boxes (and the larger of two sizes that need no air). */
  *plans(mm, T) {
    const P = mm.pic ? range(mm.picL.min, mm.picL.max).sort((x, y) => Math.abs(x - mm.picL.nat) - Math.abs(y - mm.picL.nat) || y - x) : [0];
    const B = mm.box ? [...mm.boxO].sort((x, y) => x.pad - y.pad || (y.size || 0) - (x.size || 0)) : [{ h: 0, pad: 0 }];
    if (!mm.text) { for (const p of P) for (const b of B) if (mm.F + p + b.h === T) yield { p, b }; return; }
    const n = mm.n;
    if (mm.cut) {
      // the cheapest first, which is not always the natural picture: a taller one that carries a real
      // paragraph to page 2 beats one that jumps a sentence
      const L = mm.textO[0].L, out = [];
      for (const p of P) for (const b of B) {
        const r = T - mm.F - p - b.h;
        if (r < 6 || r * n > L) continue;
        out.push(r * n === L ? { p, b, r, t: 0 } : { p, b, r, t: 0, cut: r * n - 1 });
      }
      out.sort((x, y) => this.cost(x, mm) - this.cost(y, mm));
      yield* out;
      return;
    }
    for (const o of mm.textO) {
      const r = o.L / o.n;
      for (const p of P) for (const b of B) if (mm.F + r + p + b.h === T) yield { p, b, r, t: o.t, ws: o.ws, drop: o.drop, od: o.od, tight: o.tight, n: o.n, cap: o.cap };
    }
  },

  cost(plan, mm) {
    // a jump that carries a sentence or two to page 2 is no jump at all: a newspaper would rather
    // set page one a few lines shallower and carry a real paragraph over
    const moved = plan.cut != null ? mm.textO[0].L - plan.cut : 0;
    const stub = moved > 0 && moved < 10 ? (10 - moved) * 6 : 0;
    // a picture cropped a line taller is invisible; a line of air in a box is not
    return stub + (mm.pic ? Math.abs(plan.p - mm.picL.nat) : 0) + plan.b.pad * 4 + Math.abs(plan.t || 0) * 250 + Math.abs(plan.ws || 0) * 15 + (plan.drop?.length || 0) * 3
      + (plan.n && plan.n !== mm.ns[0] ? 2 : 0) + (plan.cap === "drop2" ? 2 : plan.cap === "nocap" ? 5 : 0) + (plan.od || 0) * 8 + (plan.tight || 0) * 2;
  },

  /* The shallowest a band can be: no story above its least depth, never above data-min. */
  floor(b, models) {
    return Math.max(+b.dataset.min || 0, ...models.map((mm) => mm.F + (mm.pic ? mm.picL.min : 0) + (mm.box ? Math.min(...mm.boxO.map((o) => o.h)) : 0)
      + (mm.text ? (mm.cut ? 6 : Math.min(...mm.textO.map((o) => o.L / o.n))) : 0)));
  },

  /* The depths at which every story has some way to fit, the ones that disturb pictures and boxes
     least first. */
  depths(b, models) {
    const lo = this.floor(b, models), out = [];
    for (let T = lo; T < lo + 90; T++) {
      let total = 0, ok = true;
      for (const mm of models) {
        const first = this.plans(mm, T).next();
        if (first.done) { ok = false; break; }
        total += this.cost(first.value, mm);
      }
      if (ok) out.push({ T, total: total + (T - lo) * 0.05 });
    }
    return out.sort((x, y) => x.total - y.total).slice(0, 16).map((x) => x.T);
  },

  /* Fit one story to T lines: the first plan that passes, and how to undo it; or null. */
  apply(mm, T) {
    mm.why = {};
    for (const plan of this.plans(mm, T)) {
      this.set(mm, plan);
      const undo = plan.cut != null ? this.cut(mm, plan) : () => {};
      if (!undo) { mm.why.cut = (mm.why.cut || 0) + 1; continue; }
      const verdict = this.full(mm, T);
      if (verdict === true) return undo;
      mm.why[verdict] = (mm.why[verdict] || 0) + 1;
      undo();
    }
    return null;
  },

  set(mm, plan) {
    if (mm.pic && plan.p != null) {
      mm.pic.style.height = `${plan.p * LH}px`;
      // art deeper than its own proportions is shown whole, in a dark frame, rather than cropped
      mm.pic.classList.toggle("boxed", mm.pic.classList.contains("frame") && plan.p * LH > mm.pic.clientWidth * +mm.pic.dataset.r.split(",")[1] + 1);
    }
    if (mm.box && plan.b) {
      if (plan.b.size) mm.box.style.setProperty("--qs", `${plan.b.size}px`);
      mm.box.style.height = `${plan.b.h * LH}px`;
    }
    if (mm.text) {
      if (plan.n) mm.n = plan.n;
      if (plan.cap) { mm.text.classList.remove("drop", "drop2", "nocap"); mm.text.classList.add(plan.cap); }
      const s = mm.text.style;
      $$(":scope > h4:not(.bk):not(.keep)", mm.text).forEach((x, k) => x.classList.toggle("dropped", (plan.drop || []).includes(k)));
      const opts = $$(":scope > p.opt", mm.text);
      opts.forEach((x, k) => x.classList.toggle("dropped", k >= opts.length - (plan.od || 0)));
      const airs = $$(":scope > .air", mm.text).slice(1);
      airs.forEach((x, k) => x.classList.toggle("tight", k >= airs.length - (plan.tight || 0)));
      s.columnCount = String(mm.n); s.columnFill = "auto"; s.height = `${plan.r * LH}px`;
      s.letterSpacing = plan.t ? `${plan.t}em` : "";
      s.wordSpacing = plan.ws ? `${plan.ws}em` : "";
    }
  },

  /* Does the story end on the band's last line, every column of it? True, or what is wrong. */
  full(mm, T) {
    if (Math.abs(mm.el.getBoundingClientRect().height - T * LH) > 1) return "depth";
    return mm.text ? this.columns(mm) : true;
  },

  columns(mm, strict = false) {
    const tb = mm.text.getBoundingClientRect(), colW = (tb.width + GUT) / mm.n, cols = new Map();
    for (const el of mm.text.children) for (const q of el.getClientRects()) {
      if (q.height < 1) continue;
      const c = Math.floor((q.left - tb.left + 2) / colW), col = cols.get(c) || { top: Infinity, bottom: 0 };
      if (q.top < col.top) Object.assign(col, { top: q.top, first: el });
      if (q.bottom > col.bottom) Object.assign(col, { bottom: q.bottom, last: el });
      cols.set(c, col);
    }
    if (cols.size !== mm.n) return `columns ${cols.size}/${mm.n}`;
    const all = [...cols.values()];
    if (!all.every((c) => Math.abs(c.bottom - tb.bottom) < 1.5)) return "ragged";
    if (all.some((c) => c.last.tagName === "H4")) return "crosshead at a foot";
    if (all.some((c) => c.first.tagName === "H4" && !c.first.classList.contains("bk") && !c.first.classList.contains("keep"))) return "crosshead at a head";
    // a shelf's cover pushed to the next column, away from its title: avoided wherever the text can be
    // set any other way
    if (strict && $$(".cover", mm.text).some((x) => Math.abs(x.getBoundingClientRect().left - x.parentElement.getClientRects()[0].left) > 2)) return "cover apart";
    return true;
  },

  /* Cut a story at the line: keep plan.cut lines here, then "Continued on page 2", and move the
     rest, mid-sentence if it falls so, to the continuation. Returns how to undo it, or null. */
  cut(mm, plan) {
    const t = mm.text, keep = plan.cut, cont = $(`#${mm.cut} .text`);
    if (!cont) return null;
    const n = mm.n, s = t.style, colW = (t.clientWidth - (n - 1) * GUT) / n;
    s.columnCount = "1"; s.width = `${colW}px`; s.height = "auto";
    const limit = t.getBoundingClientRect().top + keep * LH;
    const blocks = [...t.children];
    const i = blocks.findIndex((b) => b.getBoundingClientRect().bottom > limit + 0.5);
    let undo = null;
    if (i > 0) {
      const b = blocks[i];
      if (b.getBoundingClientRect().top >= limit - 0.5) {
        if (blocks[i - 1].tagName !== "H4") {   // never end a column on a crosshead
          const moved = blocks.slice(i);
          cont.append(...moved);
          undo = () => t.append(...moved);
        }
      } else if (b.tagName === "P") {
        const at = splitPoint(b, limit);
        if (at) {
          const r = document.createRange();
          r.setStart(at.node, at.offset);
          r.setEndAfter(b.lastChild);
          const rest = h("p", { class: "flush" });
          rest.append(r.extractContents());
          const tail = b.lastChild, was = tail?.nodeType === 3 ? tail.data : null;
          if (was != null) tail.data = was.endsWith("­") ? `${was.slice(0, -1)}-` : was.replace(/\s+$/, "");   // a word broken across the jump keeps its hyphen
          b.classList.add("cut");
          const moved = [rest, ...blocks.slice(i + 1)];
          cont.append(...moved);
          undo = () => { if (was != null) tail.data = was; b.classList.remove("cut"); b.append(...rest.childNodes); rest.remove(); t.append(...moved.slice(1)); };
        }
      }
    }
    if (undo) {
      const jump = h("p", { class: "jump" }, h("a", { href: `#${mm.cut}` }, "Continued on page 2"));
      t.append(jump);
      const inner = undo;
      undo = () => { jump.remove(); inner(); };
    }
    s.columnCount = String(n); s.width = ""; s.height = `${plan.r * LH}px`;
    return undo;
  },
};

/* Where a paragraph crosses y: the first line-start on or below it. Only break opportunities are
   considered (after a space or a soft hyphen), since every line begins at one: probing character
   by character went wrong at soft hyphens and cut "inge-n|uity". A moment is never split; the cut
   goes before it. */
function splitPoint(p, y) {
  const r = document.createRange();
  const top = (node, a) => { r.setStart(node, a); r.setEnd(node, a + 1); return r.getClientRects()[0]?.top ?? -Infinity; };
  const nodes = [...p.childNodes].flatMap(function flat(n) { return n.nodeType === 1 && !n.matches(".say") ? [...n.childNodes].flatMap(flat) : [n]; });
  for (const node of nodes) {
    if (node.nodeType === 1) {   // a moment chip
      if (node.getBoundingClientRect().top >= y - 1) return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
      continue;
    }
    const s = node.data;
    if (!s.length || top(node, s.length - 1) < y - 1) continue;
    const starts = [0];
    for (let k = 1; k < s.length; k++) if (s[k - 1] === " " || s[k - 1] === "­") starts.push(k);
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top(node, starts[mid]) >= y - 1) hi = mid; else lo = mid + 1;
    }
    return { node, offset: starts[lo] };
  }
  return null;
}

/* ── moving pictures, quiet unless seen ───────────────────── */

const Loops = {
  all: new Set(),
  io: new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting && !RM.matches && !document.body.classList.contains("docked") ? e.target.play().catch(() => {}) : e.target.pause();
  }, { threshold: 0.5 }),
  watch(v) { this.all.add(v); this.io.observe(v); },
  reset() { for (const v of this.all) this.io.unobserve(v); this.all.clear(); },
  hold() { for (const v of this.all) v.pause(); },
  resume() { for (const v of this.all) { this.io.unobserve(v); this.io.observe(v); } },
};

/* ── the page, the pager, the keys ────────────────────────── */

const ARTICLE = () => innerWidth < 1180;

async function render() {
  const root = document.documentElement;
  if (root.classList.contains("set")) root.classList.add("resetting");
  Loops.reset();
  const article = ARTICLE();
  document.documentElement.classList.toggle("article", article);
  delete document.documentElement.dataset.fit;
  $("#paper").replaceChildren(page1(), page2(), page3(), page4());
  performance.mark("eie:built");
  const shown = () => { root.classList.add("set"); root.classList.remove("resetting"); };
  if (!article) {
    await document.fonts.ready;
    await Promise.all(["900 40px Mast", "800 40px Head", "400 15px Text", "700 15px Text", "italic 400 15px Text"].map((f) => document.fonts.load(f).catch(() => {})));
    performance.mark("eie:fonts");
    await Fit.run(shown);
  } else {
    $$(".page").forEach((p) => p.classList.add("set"));
    shown();
    $$(".page").forEach(stripFit);
    $$(".page").forEach(cwFit);
    // measured in the paper's own faces: a fallback font's narrower word fitted where the real one didn't
    document.fonts.ready.then(() => $$(".page").forEach((p) => { fitHeads(p); stripFit(p); }));
  }
  Pager.observe();
}

const Pager = {
  el: null, io: null,
  build() {
    this.el = h("nav", { class: "pager", "aria-label": "Pages" }, h("span", {}, "Page"),
      [1, 2, 3, 4].map((n) => h("a", { href: `#p${n}`, "aria-label": `Page ${n}` }, String(n))));
    document.body.append(this.el);
  },
  observe() {
    this.io?.disconnect();
    const seen = new Map();
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
      const cur = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0];
      for (const a of $$("a", this.el)) a.setAttribute("aria-current", String(a.getAttribute("href") === `#${cur}`));
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75] });
    for (const p of $$(".page")) this.io.observe(p);
  },
  /* On a phone the pager steps aside while you read down the page, and returns when you scroll up. */
  follow() {
    let last = scrollY;
    addEventListener("scroll", () => {
      const y = scrollY, down = y > last + 4, up = y < last - 4;
      if (down || up) this.el.classList.toggle("away", down && document.documentElement.classList.contains("article") && y > 200);
      if (down || up) last = y;
    }, { passive: true });
  },
};

function wire() {
  $(".dock-close").addEventListener("click", (ev) => {
    const keyboardInDock = $("#dock").contains(document.activeElement) && Dock.keyboard;
    const origin = Player.origin;
    Player.close();
    $("#dock").hidden = true;
    document.body.classList.remove("docked");
    Loops.resume();
    if (ev.detail === 0 && keyboardInDock && origin?.isConnected) origin.focus();
  });
  $("#dock").addEventListener("focusin", (ev) => { Dock.keyboard = ev.target.matches(":focus-visible"); });
  $(".dock-replay").addEventListener("click", () => Player.replay());
  $(".dock-toggle").addEventListener("click", () => Player.toggle());
  $(".dock-more").addEventListener("click", () => Player.more());
  new MutationObserver(() => { if (document.body.classList.contains("docked")) Loops.hold(); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => { const b = $(".dock-toggle"); b.textContent = b.getAttribute("aria-label"); })
    .observe($(".dock-toggle"), { attributes: true, attributeFilter: ["aria-label"] });
  addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || $("#dock").hidden) return;
    // never while typing: a K in the crossword, or in the desk's question, is a letter, not a pause
    if (ev.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (document.documentElement.classList.contains("desk-open")) return;   // the desk's sheet has the keys
    if (ev.key === "Escape") return $(".dock-close").click();
    const k = ev.key.toLowerCase();
    if (k === "k") { ev.preventDefault(); Player.toggle(); }
    if (k === "j") { ev.preventDefault(); Player.seek(-10); }
    if (k === "l") { ev.preventDefault(); Player.seek(10); }
  });
  // a new width is a new page: type fits one measure only, so set it again
  let w = innerWidth, timer = 0;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (Math.abs(innerWidth - w) > 2) { w = innerWidth; render().then(land); } }, 220);
  });
}

function land() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
}

async function main() {
  performance.mark("eie:start");
  const [d, e] = await Promise.all([
    fetch("data.json").then((r) => r.json()),
    fetch("edition.json").then((r) => r.json()),
  ]);
  D = d; E = e;
  performance.mark("eie:data");
  let t = 0;
  WORDS = { t: d.words.t.map((x) => (t += x)), w: d.words.w, s: d.words.s };
  Pager.build();
  Pager.follow();
  wire();
  await render();
  land();
  window.__eie = { Player, Fit };
  document.documentElement.dataset.ready = "true";
}

main().catch((err) => { console.error(err); $("#paper").append(h("p", { class: "page" }, "The paper couldn’t load. Serve the published site over http (sh site/publish.sh out, then python3 -m http.server --directory out).")); });
