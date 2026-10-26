// Everything is Everything, distilled: one episode as things to remember, each a click away from
// the moment it was said. Everything here renders from data/NNN.json (site/build.py); text goes in
// as text, and only the plates, which are our own files, go in as markup.

const EP = 45;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NAMES = ["Amit Varma", "Ajay Shah", "someone else"];
const FIRST = ["Amit", "Ajay", "Someone else"];
const PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 0.8v8.4L9 5z"/></svg>';
const RING = '<svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="14"/></svg>';

let D, A;            // this episode, and the archive
let WORDS;           // this episode's words: {t: [cs], w: [text], s: [speaker]}
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ── little helpers ───────────────────────────────────────── */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;            // trusted markup only: plates and icons
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") {
      // Object.assign drops custom properties (--h, --j-bg) silently; setProperty takes both kinds.
      for (const [p, x] of Object.entries(v)) p.startsWith("--") ? el.style.setProperty(p, x) : (el.style[p] = x);
    }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
}

// replaceChildren prints a null child as the word "null"; this drops the absent ones first.
function put(el, ...kids) { el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); return el; }

function clock(cs) {
  const s = Math.floor(cs / 100);
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
function spoken(cs) {   // "4 min 51 s", for a screen reader and a length
  const s = Math.round(cs / 100);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}
function length(cs) {   // m:ss, never rounded up
  const s = Math.floor(cs / 100);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
function day(iso, withYear = true) {
  const d = new Date(iso + "T12:00:00");
  const year = withYear && d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}
function plural(n, one, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }
function chapterName(title) { return title.replace(/^Chapter \d+:\s*/, "").replace(/^Introduction:\s*/, ""); }
function chapterLabel(i) {
  const t = D.episode.chapters[i].title;
  const m = t.match(/^Chapter (\d+)/);
  return m ? `Chapter ${m[1]}` : t.startsWith("Introduction") ? "Introduction" : t;
}
function domain(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function hash(s) { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; }
const titleOf = (it) => it.concept || it.topic || it.item || it.content;

function plate(id, label, decorative = false) {
  const svg = D.art?.[id];
  if (decorative) return h("div", { class: "art", html: svg || "", "aria-hidden": "true" });
  return h("div", { class: "art", html: svg || "", "data-missing": !svg && "true", role: svg ? null : "img", "aria-label": svg ? null : label });
}

/* The moment chip: play glyph, time, who speaks. `m` carries clip, at, spk, and for other episodes words. */
function chip(m, { text, big, solid, len, label, onplay } = {}) {
  if (!m?.clip) return null;
  const who = FIRST[m.spk ?? 2];
  const b = h("button", {
    type: "button", class: `moment${big ? " big" : ""}${solid ? " solid" : ""}`, "data-s": m.spk ?? 2,
    "aria-label": label || `Play ${spoken(m.clip[1] - m.clip[0])}: ${who}, at ${clock(m.at?.[0] ?? m.clip[0])}`,
    html: `<span class="disc">${PLAY}${RING}</span>`,
  });
  b.append(h("span", { class: "t" }, text || `${clock(m.at?.[0] ?? m.clip[0])} · ${who}`));
  if (len) b.append(h("span", { class: "len t" }, len));
  b.addEventListener("click", () => (onplay ? onplay(b) : Player.play(m, b)));
  b.addEventListener("pointerenter", () => Player.warm(), { once: true });
  b.addEventListener("focus", () => Player.warm(), { once: true });
  return b;
}
const here = (it) => it.clip && { ...it, ep: EP, videoId: D.episode.videoId, title: titleOf(it) };

/* ── keep (bookmarks) ─────────────────────────────────────── */

const kept = new Set(store.get("eie.kept", []));
function keepButton(id, title) {
  const b = h("button", { type: "button", class: "keep", "aria-pressed": String(kept.has(id)), "aria-label": `Keep “${title}” to practise it` },
    h("span", { html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.8h9v12.4L8 11l-4.5 3.2z"/></svg>' }), h("span", {}, kept.has(id) ? "Kept" : "Keep"));
  b.addEventListener("click", () => {
    kept.has(id) ? kept.delete(id) : kept.add(id);
    store.set("eie.kept", [...kept]);
    for (const other of $$(`.keep[data-id="${id}"]`)) {
      other.setAttribute("aria-pressed", String(kept.has(id)));
      other.lastChild.textContent = kept.has(id) ? "Kept" : "Keep";
    }
    Practice.refresh();
  });
  b.dataset.id = id;
  return b;
}

/* ── the player ───────────────────────────────────────────── */

const Player = {
  yt: null, api: null, made: null, cur: null, queue: [], reel: 0, chip: null, raf: 0, watch: 0, next: 0,
  hintTimer: 0, words: null, window: [0, 0], target: null,

  warm() { if (location.protocol !== "file:") this.loadApi().catch(() => {}); },
  loadApi() {
    // A blocked or slow script must not leave every later click hanging: give up after 12 s and let
    // the next click try again. If the script turns up late, that next click finds it ready: a
    // second copy of the script would load nothing and never say so.
    if (window.YT?.Player) return Promise.resolve();
    if (!this.api) this.api = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = resolve;
      if (!$('script[src*="youtube.com/iframe_api"]')) {
        const tag = h("script", { src: "https://www.youtube.com/iframe_api" });
        tag.onerror = () => { tag.remove(); reject(new Error("blocked")); };
        document.head.append(tag);
      }
      setTimeout(() => (window.YT?.Player ? resolve() : reject(new Error("timeout"))), 12000);
    }).catch((e) => { this.api = null; this.made = null; throw e; });
    return this.api;
  },
  ready() { return !!this.yt?.getPlayerState; },

  async play(m, chipEl, queue = [], fromQueue = false) {
    m = m.videoId ? m : { ...m, videoId: videoOf(m.ep ?? EP) };
    clearTimeout(this.next);   // any play, by a click or the reel, cancels a reel's pending step
    if (!fromQueue) {
      this.reel = queue.length ? queue.length + 1 : 0;
      this.origin = document.activeElement !== document.body ? document.activeElement : chipEl;
    }
    if (location.protocol === "file:") {   // YouTube refuses embeds on a page with no web address
      window.open(`https://www.youtube.com/watch?v=${m.videoId}&t=${Math.floor(m.clip[0] / 100)}s`, "_blank", "noopener");
      return;
    }
    this.queue = queue;
    if (!store.get("eie.played", false)) { store.set("eie.played", true); $(".first-hint")?.remove(); }
    this.setChip(chipEl);
    const cur = this.cur = { ...m, free: !!m.free, open: !!m.free, ended: false };
    this.words = wordsFor(m);
    this.window = [0, 0];
    Dock.open(m, this.reel ? `${this.reel - queue.length} of ${this.reel}` : "");
    const start = m.clip[0] / 100;
    // One player for the page, made once and without autoplay: it plays only when asked, so a dock
    // closed while the player was still loading stays silent. A click during loading waits, then
    // the last click wins.
    this.made ||= this.loadApi().then(() => new Promise((resolve) => {
      this.yt = new YT.Player("yt", {
        host: "https://www.youtube-nocookie.com", videoId: m.videoId,
        playerVars: { autoplay: 0, start: Math.floor(start), playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => this.state(e.data),
          onError: (e) => Dock.error(this.cur),
        },
      });
    }));
    try { await this.made; } catch { if (this.cur === cur) Dock.error(cur, "YouTube's player didn't load. "); return; }
    if (this.cur !== cur) return;   // closed, or a later click took over, while the player was loading
    this.target = m.clip[0];
    if (this.yt.getVideoData?.().video_id === m.videoId) {
      this.yt.seekTo(start, true);
      this.yt.playVideo();
    } else {
      this.yt.loadVideoById({ videoId: m.videoId, startSeconds: start });
    }
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {   // some phones won't start a video the page asks for until it's tapped once
      const s = this.yt?.getPlayerState?.();
      $(".dock-hint").hidden = !(s === -1 || s === 5);
    }, 2600);
    this.loop();
  },

  state(s) {
    if (s === 1 || s === 3) $(".dock-hint").hidden = true;
    if (s === 1) for (const m of ["captions", "cc"]) this.yt.unloadModule?.(m);
    if (s === 1) $("#dock").removeAttribute("data-ended");
    const paused = s === 2 || s === 0 || s === 5;
    $("#dock").toggleAttribute("data-paused", paused);
    $(".dock-toggle").setAttribute("aria-label", paused ? "Play" : "Pause");
  },

  /* Where playback is, in centiseconds. Straight after a seek YouTube still reports the old time for a
     few frames; until it reaches the target, the target is the truth. (Reading the old time made an
     earlier moment in the same video end the instant it started.) */
  now() {
    const t = this.yt.getCurrentTime() * 100;
    if (this.target != null) {
      if (Math.abs(t - this.target) < 200) this.target = null;
      else return this.target;
    }
    return t;
  },

  loop() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.watch);
    // Drawing follows animation frames; the clip's end is watched on a timer too, because a
    // background tab gets no frames and a clip there would otherwise play on into the episode.
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const c = this.cur;
      if (!c || !this.ready()) return;
      const t = this.now();
      const [a, b] = c.clip;
      const p = Math.max(0, Math.min(1, (t - a) / (b - a)));
      $("#dock").style.setProperty("--p", c.free ? 0 : p);
      if (this.chip) this.chip.style.setProperty("--p", c.free ? 1 : p);
      Dock.caption(t);
      Strip.playhead(c.videoId === D.episode.videoId ? t : null);
      this.check();
    };
    tick();
    this.watch = setInterval(() => this.check(), 250);
  },

  check() {
    const c = this.cur;
    if (!c || c.free || c.ended || !this.ready()) return;
    const t = this.now();   // clears a landed seek: in a background tab nothing else would
    if (this.target == null && this.yt.getPlayerState() === 1 && t >= c.clip[1]) this.end();
  },

  end() {   // once per clip
    this.cur.ended = true;
    this.yt.pauseVideo();
    if (this.queue.length) {
      const [next, ...rest] = this.queue;
      this.next = setTimeout(() => this.play(next, this.chip, rest, true), 650);
      return;
    }
    Dock.ended();
  },

  setChip(el) {
    if (this.chip && this.chip !== el) { this.chip.removeAttribute("data-playing"); this.chip.style.removeProperty("--p"); }
    this.chip = el || null;
    if (el) el.setAttribute("data-playing", "");
  },

  /* Anything the listener does takes over from the reel. */
  stopReel() {
    clearTimeout(this.next);
    if (this.reel && this.cur) Dock.title(this.cur, "");
    this.queue = []; this.reel = 0;
  },
  toggle() {
    if (!this.ready() || !this.cur) return;
    const s = this.yt.getPlayerState();
    if (s === 1 || s === 3) { this.yt.pauseVideo(); return; }   // a pause holds the reel; it doesn't end it
    // Playing on from the end of a clip means listening on, not hearing its last word again.
    if (this.cur.ended) this.more();
    else this.yt.playVideo();
  },
  seek(ds) {
    if (!this.ready() || !this.cur) return;
    this.stopReel();
    const last = (this.yt.getDuration?.() || Infinity) * 100 - 100;
    const to = Math.max(0, Math.min(last, this.now() + ds * 100));
    this.target = to;
    this.yt.seekTo(to / 100, true);
    this.cur.free = true;
    Dock.freed();
  },
  replay() {
    if (!this.ready() || !this.cur) return;
    this.stopReel();
    Object.assign(this.cur, { free: this.cur.open, ended: false });
    this.target = this.cur.clip[0];
    this.yt.seekTo(this.cur.clip[0] / 100, true);
    this.yt.playVideo();
    Dock.replayed();
  },
  more() {
    if (!this.ready() || !this.cur) return;
    this.stopReel();
    Object.assign(this.cur, { free: true, ended: false });
    this.yt.playVideo();
    Dock.freed();
  },
  close() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.watch);
    this.stopReel();
    if (this.ready()) this.yt.pauseVideo();
    const back = this.chip;
    this.setChip(null);
    this.cur = null;
    this.target = null;
    Strip.playhead(null);
    return back;
  },
};

function videoOf(n) { return n === EP ? D.episode.videoId : A.episodes.find((e) => e.n === n)?.videoId; }

/* The words to caption a moment with: this episode's whole transcript, or the clip's own words. */
function wordsFor(m) {
  if ((m.ep ?? EP) === EP) return WORDS;
  if (!m.words) return null;
  return { t: m.words.map((w) => w[0]), w: m.words.map((w) => w[1]), s: m.words.map((w) => w[2]) };
}

const Dock = {
  open(m, position) {
    const dock = $("#dock");
    dock.hidden = false;
    dock.removeAttribute("data-ended");
    dock.style.setProperty("--c", `var(--${["amit", "ajay", "other"][m.spk ?? 2]})`);
    const ep = m.ep ?? EP;
    this.title(m, position);
    $(".dock-more").hidden = !!m.free;
    $(".dock-caption").replaceChildren();
    $("#dock-status").textContent = `Playing ${m.title || "a moment"}: ${FIRST[m.spk ?? 2]}, from ${clock(m.clip[0])} of Episode ${ep}.`;
    document.body.classList.add("docked");
  },
  title(m, position) {
    const title = $(".dock-title");
    put(title, position ? `${position} · ` : null, h("b", {}, `Episode ${m.ep ?? EP}`), ` · ${m.title || ""}`,
      h("span", { class: "dock-when" }, ` · ${FIRST[m.spk ?? 2]}, ${clock(m.at?.[0] ?? m.clip[0])}`));
  },
  ended() {
    $("#dock").setAttribute("data-ended", "");
    $(".dock-more").hidden = false;
  },
  freed() { $(".dock-more").hidden = true; },
  replayed() { $(".dock-more").hidden = !!Player.cur?.free; },   // a moment with no end has nothing to keep listening to
  error(m, why = "YouTube won't play this video here. ") {
    const cap = $(".dock-caption");
    const url = `https://www.youtube.com/watch?v=${m?.videoId}&t=${Math.floor((m?.clip[0] ?? 0) / 100)}s`;
    Player.words = null;   // the message stays put instead of being drawn over by captions
    put(cap, why, h("a", { href: url, target: "_blank", rel: "noopener" }, "Open it on YouTube at this moment ↗"));
    $("#dock-status").textContent = `${why}A link to it on YouTube is in the player.`;
  },
  /* Karaoke: a window of words around the one being said, each lit as it's spoken. */
  caption(t) {
    const W = Player.words, box = $(".dock-caption");
    if (!W) return;
    let i = upper(W.t, t) - 1;
    if (i < 0) i = 0;
    const [lo, hi] = Player.window;
    const short = i < lo && lo > 0 || i > hi - 12 && hi < W.w.length;   // past either edge, and there is more beyond it
    if (!box.firstChild || short) {
      const a = Math.max(0, i - 8), b = Math.min(W.w.length, i + 48);
      const frag = document.createDocumentFragment();
      let last = -1;
      for (let k = a; k < b; k++) {
        if (W.s[k] !== last) { frag.append(h("span", { class: "sp", "data-s": W.s[k] }, FIRST[W.s[k]])); last = W.s[k]; }
        frag.append(h("span", { class: "w", "data-s": W.s[k], "data-k": k }, W.w[k]), " ");
      }
      put(box, frag);
      Player.window = [a, b];
      this.lit = -1;
    }
    if (this.lit === i) return;
    this.lit = i;
    for (const el of box.querySelectorAll(".w")) {
      const k = +el.dataset.k;
      el.classList.toggle("said", k < i);
      el.classList.toggle("now", k === i);
    }
    const now = box.querySelector(".w.now");
    if (now) {
      const line = parseFloat(getComputedStyle(box).lineHeight);
      const row = Math.round((now.offsetTop - box.offsetTop) / line);
      box.scrollTop = Math.max(0, row - 1) * line;
    }
  },
};

function upper(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; arr[m] <= x ? (lo = m + 1) : (hi = m); } return lo; }

/* ── the ribbon of 128 episodes ───────────────────────────── */

function renderRibbon() {
  const ribbon = $(".ribbon");
  ribbon.setAttribute("role", "group");
  const max = Math.max(...A.episodes.map((e) => e.seconds));
  for (const e of A.episodes) {
    const b = h("button", {
      type: "button", "aria-label": `Episode ${e.n}, ${e.title}: ${Math.floor(e.seconds / 60)} minutes; Amit talks ${Math.round(e.share[0] * 100)}%, Ajay ${Math.round(e.share[1] * 100)}%`,
      style: { "--h": `${Math.max(18, (e.seconds / max) * 100)}%`, "--a": `${(e.share[0] * 100).toFixed(1)}%` },
      "aria-current": e.n === EP ? "true" : null,
    });
    b.addEventListener("pointerenter", () => Ribbon.show(e, b));
    b.addEventListener("focus", () => Ribbon.show(e, b));
    b.addEventListener("click", () => Ribbon.show(e, b, true));
    ribbon.append(b);
  }
  ribbon.addEventListener("pointerleave", () => Ribbon.hideSoon());
  // One tab stop for 128 bars: Tab lands on this episode, arrows walk the rest (Home and End jump).
  ribbon.setAttribute("aria-label", "All 128 episodes; use the arrow keys to move between them");
  [...ribbon.children].forEach((b) => b.setAttribute("tabindex", b.getAttribute("aria-current") ? "0" : "-1"));
  const rove = (bar) => [...ribbon.children].forEach((b) => b.setAttribute("tabindex", b === bar ? "0" : "-1"));
  ribbon.addEventListener("focusin", (ev) => rove(ev.target));
  ribbon.addEventListener("keydown", (ev) => {
    const bars = [...ribbon.children], i = bars.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bars.length - 1 }[ev.key];
    if (to == null || i < 0) return;
    ev.preventDefault();
    bars[Math.max(0, Math.min(bars.length - 1, to))].focus();
  });
  // On a phone each bar is under 2 px wide, too thin to tap: slide a finger along the ribbon instead.
  const bars = [...ribbon.children];
  const scrub = (ev) => {
    if (ev.pointerType === "mouse") return;
    const r = ribbon.getBoundingClientRect();
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(((ev.clientX - r.left) / r.width) * bars.length)));
    bars.forEach((b, k) => b.toggleAttribute("data-near", k === i));
    Ribbon.show(A.episodes[i], bars[i], true);
  };
  ribbon.addEventListener("pointerdown", (ev) => { if (ev.pointerType !== "mouse") { ribbon.setPointerCapture(ev.pointerId); scrub(ev); } });
  ribbon.addEventListener("pointermove", (ev) => { if (ribbon.hasPointerCapture(ev.pointerId)) scrub(ev); });
  ribbon.addEventListener("pointerup", () => bars.forEach((b) => b.removeAttribute("data-near")));
  // The browser took the gesture for a scroll: it was never a choice, so leave nothing behind.
  ribbon.addEventListener("pointercancel", () => { bars.forEach((b) => b.removeAttribute("data-near")); Ribbon.hide(); });
  document.addEventListener("pointerdown", (ev) => { if (!ev.target.closest(".ribbon, .ribbon-tip")) Ribbon.hide(); });
}

const Ribbon = {
  timer: 0, pinned: false,
  show(e, bar, pin) {
    clearTimeout(this.timer);
    if (pin) this.pinned = true;
    const tip = $(".ribbon-tip");
    const share = `Amit ${Math.round(e.share[0] * 100)}% · Ajay ${Math.round(e.share[1] * 100)}%`;
    const m = { ...e.moment, ep: e.n, videoId: e.videoId };
    put(tip, 
      h("span", { class: "label t" }, `Episode ${e.n} · ${day(e.date)} · ${Math.floor(e.seconds / 60)} min`),
      h("h3", {}, e.title),
      e.n === EP
        ? h("p", {}, "You're reading this one.")
        : h("p", {}, "“", m.quote || m.title, "”"),
      h("div", { class: "row" }, e.n === EP ? null : chip(m, { text: `Hear it · ${FIRST[m.spk]}`, label: `Hear a moment from Episode ${e.n}` })),
      h("span", { class: "label", style: { marginTop: "10px" } }, `${share} of the talking`),
    );
    tip.hidden = false;
    const r = bar.getBoundingClientRect(), host = $(".archive").getBoundingClientRect();
    const w = tip.offsetWidth;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, 12), window.innerWidth - w - 12) - host.left;
    tip.style.left = `${x}px`;
    tip.style.top = `${r.bottom - host.top + 14}px`;
    tip.onpointerenter = () => clearTimeout(this.timer);
    tip.onpointerleave = () => this.hideSoon();
  },
  hideSoon() { if (!this.pinned) this.timer = setTimeout(() => this.hide(), 260); },
  hide() { this.pinned = false; $(".ribbon-tip").hidden = true; },
};

/* ── masthead ─────────────────────────────────────────────── */

function keyIdeas() {   // the first idea said in each chapter: the episode in a handful of moments
  const ideas = D.items.filter((i) => i.id[4] === "C" && i.clip);
  const firsts = new Map();
  for (const it of ideas.sort((a, b) => a.at[0] - b.at[0])) if (!firsts.has(it.chapter)) firsts.set(it.chapter, it);
  return [...firsts.values()];
}

function renderMasthead() {
  const e = D.episode;
  const fallacies = keyIdeas().filter((it) => /Fallacy/.test(e.chapters[it.chapter].title));
  const reel = fallacies.map(here);
  const total = reel.reduce((s, m) => s + m.clip[1] - m.clip[0], 0);
  const signs = [[54, 54], [127, 86], [200, 40], [273, 92], [346, 62]];
  // The cover is the table of contents: each sign links to its fallacy, and the row beneath names them.
  const short = (c) => { const t = c.replace(/^The\s+/i, "").replace(/\s+(fallacy|and its cousins|and no free lunch).*$/i, "").replace(/^fallacy of /i, ""); return t[0].toUpperCase() + t.slice(1); };
  const cover = h("div", { class: "cover" }, plate("cover", "Five warning signs, one for each fallacy"),
    h("div", { class: "cover-signs", "aria-hidden": "true" },
      fallacies.map((it, k) => h("a", { href: `#${it.id}`, tabindex: "-1", style: { left: `${signs[k][0] / 4}%`, top: `${signs[k][1] / 3}%` } }))),
    h("nav", { class: "cover-legend", "aria-label": "The five fallacies" },
      h("ol", {}, fallacies.map((it) => h("li", {}, h("a", { href: `#${it.id}` }, short(it.concept)))))));
  const reelChip = chip(reel[0], {
    big: true, solid: true, text: "Hear the five fallacies", len: length(total),
    label: `Hear the five fallacies in their own words: ${reel.length} moments, ${spoken(total)}`,
    onplay: (b) => Player.play(reel[0], b, reel.slice(1)),
  });
  const yt = `https://www.youtube.com/watch?v=${e.videoId}`;
  $(".masthead").append(cover, h("div", { class: "text" },
    h("p", { class: "ep-meta label t" }, h("span", {}, `Episode ${e.n}`), h("span", {}, day(e.date)), h("span", {}, `${Math.floor(e.seconds / 60)} min`)),
    h("h1", { id: "ep-title" }, e.title),
    h("p", { class: "tagline" }, e.tagline.replace(/\s--\s/g, " — ")),
    h("p", { class: "about" }, e.about),
    h("div", { class: "actions" }, reelChip,
      h("a", { class: "pill", href: yt, target: "_blank", rel: "noopener" }, "Watch the episode", h("span", { "aria-hidden": "true" }, " ↗"))),
    // First visit only: the one thing to know. Gone for good once something has played.
    store.get("eie.played", false) ? null : h("p", { class: "label first-hint" },
      h("span", { class: "disc-mini", html: PLAY, "aria-hidden": "true" }), "Every play button on this page starts the video at the moment it was said, and lights up the words as they're spoken."),
  ));
}

/* ── the conversation strip ───────────────────────────────── */

const GLYPHS = {
  C: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg>',
  S: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1.5"/></svg>',
  R: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1h7v10l-3.5-2.6L2.5 11z"/></svg>',
  J: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l5.2 10.4H.8z"/></svg>',
};
const KIND = { C: "Idea", S: "Story", R: "Recommendation", J: "Laugh" };

const Strip = {
  el: null,
  render() {
    const e = D.episode, dur = e.seconds * 100;
    const pct = (cs) => `${(cs / dur) * 100}%`;
    const wrap = $(".strip-wrap");
    const head = h("div", { class: "strip-head" },
      h("h2", { id: "strip-title" }, "The conversation, minute by minute"),
      h("span", { class: "who", "data-s": "0" }, `Amit ${Math.round(D.share[0] * 100)}%`),
      h("span", { class: "who", "data-s": "1" }, `Ajay ${Math.round(D.share[1] * 100)}%`),
      h("span", { class: "label hint" }, matchMedia("(hover: hover)").matches ? "Point to read along; click to listen from there." : "Tap to listen from any minute."));
    const chapters = h("div", { class: "strip-chapters" });
    e.chapters.forEach((c, i) => {
      const end = (e.chapters[i + 1]?.start ?? e.seconds) * 100;
      if (end - c.start * 100 < 3000) return;   // the 13-second "packaging" teaser needs no label
      chapters.append(h("button", {
        type: "button", style: { left: pct(c.start * 100), width: pct(end - c.start * 100) },
        title: c.title, onclick: () => this.listen(c.start * 100),
      }, chapterName(c.title)));
    });
    const turns = h("div", { class: "strip-turns", "aria-hidden": "true" });
    for (const [a, b, s] of D.turns) turns.append(h("i", { "data-s": s, style: { left: pct(a), width: pct(Math.max(b - a, 20)) } }));
    const marks = h("div", { class: "strip-marks" });
    for (const it of D.items.filter((i) => i.at).sort((x, y) => x.at[0] - y.at[0])) {
      const k = it.id[4];
      marks.append(h("button", {
        type: "button", html: GLYPHS[k], "data-t": it.at[0], style: { left: pct(it.at[0]) },
        "aria-label": `${KIND[k]} at ${clock(it.at[0])}: ${titleOf(it)}`,
        onclick: (ev) => Player.play(here(it), document.getElementById(it.id)?.querySelector(".moment") || ev.currentTarget),
        onpointerenter: (ev) => this.tip(it.at[0], `${KIND[k]} · ${clock(it.at[0])}`, titleOf(it), ev.currentTarget),
        onpointerleave: () => this.untip(),
      }));
    }
    const axis = h("div", { class: "strip-axis t", "aria-hidden": "true" });
    for (let m = 0; m * 6000 < dur; m += 10) axis.append(h("span", { style: { left: pct(m * 6000) } }, `${m}:00`));
    this.el = h("div", { class: "strip" }, chapters, turns, marks, axis,
      h("div", { class: "strip-head-line" }), h("div", { class: "strip-play" }), h("div", { class: "strip-tip", hidden: true }));
    const legend = h("div", { class: "legend label" }, Object.entries(KIND).map(([k, name]) =>
      h("span", {}, h("span", { html: GLYPHS[k] }), `${name === "Recommendation" ? "Book or link" : name}`)));
    wrap.append(head, this.el, legend);

    turns.addEventListener("pointermove", (ev) => {
      const t = this.timeAt(ev);
      const i = Math.max(0, upper(WORDS.t, t) - 1);
      const words = WORDS.w.slice(Math.max(0, i - 3), i + 12).join(" ");
      this.tip(t, `${clock(t)} · ${FIRST[WORDS.s[i]]}`, `…${words}…`, null, ev);
    });
    turns.addEventListener("pointerleave", () => this.untip());
    turns.addEventListener("click", (ev) => this.listen(this.timeAt(ev)));
    new ResizeObserver(() => this.layoutMarks()).observe(this.el);
  },
  timeAt(ev) {
    const r = this.el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * D.episode.seconds * 100;
  },
  listen(t) {
    const i = Math.max(0, upper(WORDS.t, t) - 1);
    // start at the beginning of the word under the pointer, and run on with no end
    Player.play({ ep: EP, videoId: D.episode.videoId, clip: [WORDS.t[i] - 20, WORDS.t[i] + 6000], at: [WORDS.t[i]], spk: WORDS.s[i], free: true, title: `from ${clock(t)}` }, null);
  },
  tip(t, label, text, anchor, ev) {
    const tip = $(".strip-tip", this.el), line = $(".strip-head-line", this.el);
    const r = this.el.getBoundingClientRect();
    const x = anchor ? anchor.getBoundingClientRect().left + 11 - r.left : ev.clientX - r.left;
    put(tip, h("span", { class: "label t" }, label), text);
    tip.hidden = false;
    const half = Math.min(140, (r.width - 8) / 2);
    tip.style.width = `${half * 2}px`;
    tip.style.left = `${Math.min(Math.max(x, half), r.width - half)}px`;
    line.style.left = `${x}px`;
  },
  untip() { $(".strip-tip", this.el).hidden = true; },
  playhead(t) {
    if (!this.el) return;
    if (t == null) { this.el.removeAttribute("data-playing"); return; }
    this.el.setAttribute("data-playing", "");
    $(".strip-play", this.el).style.left = `${(t / (D.episode.seconds * 100)) * 100}%`;
  },
  /* Marks that would sit on each other drop to a second row; ties resolve by time, so a redraw never shuffles them. */
  layoutMarks() {
    const w = this.el.getBoundingClientRect().width;
    const last = [-1e9, -1e9];
    for (const b of $$(".strip-marks button", this.el)) {
      const x = (+b.dataset.t / (D.episode.seconds * 100)) * w;
      const row = x - last[0] >= 16 ? 0 : x - last[1] >= 16 ? 1 : 0;
      b.style.setProperty("--row", row);
      last[row] = x;
    }
  },
};

/* ── sections ─────────────────────────────────────────────── */

const EMBLEMS = {
  ideas: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M28 13a10 10 0 0 0-6 18v5h12v-5a10 10 0 0 0-6-18zm-5 26h10v3H23zm2 5h6v3h-6z"/>',
  stories: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M13 17h30a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H27l-8 7v-7h-6a3 3 0 0 1-3-3V20a3 3 0 0 1 3-3z"/>',
  shelf: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M12 14h7v28h-7zm9 4h6v24h-6zm8-2h7v26h-7zm9 3l6-1.6 5.6 21.8-6 1.6zM9 43h38v3H9z"/>',
  laughs: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M28 14a14 14 0 1 0 0 28 14 14 0 0 0 0-28zm-5 9a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zm10 0a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM19 31h18a9 9 0 0 1-18 0z" fill-rule="evenodd"/>',
  remember: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M28 13a15 15 0 1 0 14.4 19.2l-4-1.2A10.8 10.8 0 1 1 35 20.6L30 25h13V12l-4.9 4.9A15 15 0 0 0 28 13z"/>',
  onward: '<circle class="e1" cx="22" cy="30" r="16"/><circle class="e2" cx="34" cy="30" r="16"/><path class="e3" d="M28 12l5 13 13 5-13 5-5 13-5-13-13-5 13-5z"/>',
};

function secHead(id, title, count, line) {
  return h("div", { class: "sec-head" },
    h("span", { class: "emblem", html: `<svg viewBox="0 0 56 56" aria-hidden="true">${EMBLEMS[id]}</svg>` }),
    h("h2", { id: `${id}-title` }, title, count != null ? h("span", { class: "count t" }, String(count)) : null),
    h("p", {}, line));
}

function bigLink(bid) {
  const b = D.bigIdeas.find((x) => x.id === bid);
  if (!b) return null;
  const dots = h("span", { class: "dots", "aria-hidden": "true" }, Array.from({ length: Math.min(b.episodes.length, 30) }, () => h("i")));
  return h("button", { type: "button", class: "big-link", onclick: () => Drawer.open(b.id) },
    h("span", {}, "Part of a big idea: ", h("b", {}, b.name), ` · in ${b.episodes.length} episodes`), dots);
}

function renderIdeas() {
  const sec = $("#ideas");
  const ideas = D.items.filter((i) => i.id[4] === "C").sort((a, b) => (a.at?.[0] ?? 0) - (b.at?.[0] ?? 0));
  sec.append(secHead("ideas", "Ideas", ideas.length, "What's worth keeping, in the order it came up."));
  const byChapter = new Map();
  for (const it of ideas) { const c = it.chapter ?? 0; byChapter.set(c, [...(byChapter.get(c) || []), it]); }
  for (const [c, items] of byChapter) {
    const ch = D.episode.chapters[c];
    const group = h("div", { class: "chapter", id: `ch-${c}` },
      h("div", { class: "chapter-label" },
        h("span", { class: "label t" }, `${chapterLabel(c)} · ${clock(ch.start * 100)}`),
        h("h3", {}, chapterName(ch.title)),
        chip({ ep: EP, videoId: D.episode.videoId, clip: [ch.start * 100, ch.start * 100 + 6000], at: [ch.start * 100], spk: speakerAt(ch.start * 100 + 200), free: true, title: chapterName(ch.title) },
          { text: `Listen from ${clock(ch.start * 100)}`, label: `Listen to ${chapterName(ch.title)} from ${clock(ch.start * 100)}` })),
      h("div", { class: "cards" }, items.map((it, k) => ideaCard(it, k === 0))));
    sec.append(group);
  }
}

function speakerAt(t) { return WORDS.s[Math.max(0, upper(WORDS.t, t) - 1)]; }

function ideaCard(it, feature) {
  return h("article", { class: `card${feature ? " feature" : ""}`, id: it.id },
    plate(it.id, it.concept),
    h("h4", {}, it.concept),
    h("p", { class: "body" }, it.explanation),
    it.quote ? h("blockquote", { "data-s": it.spk ?? 2 }, it.quote) : null,
    h("div", { class: "row" }, chip(here(it)), keepButton(it.id, it.concept)),
    (it.big || []).map(bigLink),
  );
}

function renderStories() {
  const sec = $("#stories");
  const stories = D.items.filter((i) => i.id[4] === "S").sort((a, b) => (a.span?.[0] ?? a.at?.[0]) - (b.span?.[0] ?? b.at?.[0]));
  sec.append(secHead("stories", "Stories", stories.length, "The ones you'd retell over coffee, and what each one teaches."));
  const list = h("div", { class: "stories" });
  for (const it of stories) {
    const teller = NAMES.indexOf(it.teller);
    const whole = it.span && { ...here(it), clip: it.span, at: [it.span[0]], title: `${it.topic} (the whole story)` };
    list.append(h("article", { class: "story", id: it.id },
      plate(it.id, it.topic),
      h("div", {},
        h("span", { class: "label" }, h("span", { class: "who", "data-s": teller }, `Told by ${it.teller}`),
          it.chapter != null ? ` · ${chapterName(D.episode.chapters[it.chapter].title)}` : ""),
        h("h3", {}, it.topic),
        h("p", { class: "summary" }, it.summary),
        h("p", { class: "point" }, h("span", { class: "label" }, "Why it stays with you"), it.insight),
        it.quote ? h("blockquote", {}, it.quote) : null,
        h("div", { class: "row" },
          chip(here(it), { text: "The line", len: length(it.clip[1] - it.clip[0]), label: `Hear the line: ${spoken(it.clip[1] - it.clip[0])}` }),
          whole && chip(whole, { text: "The whole story", len: length(it.span[1] - it.span[0]), label: `Hear the whole story, from ${clock(it.span[0])}: ${spoken(it.span[1] - it.span[0])}` }),
          keepButton(it.id, it.topic)),
      )));
  }
  sec.append(list);
}

/* ── the shelf ────────────────────────────────────────────── */

const SHELF_KINDS = [
  ["all", "All"],
  ["book", "Books", (t) => t === "book"],
  ["read", "Essays and articles", (t) => ["essay", "article", "paper", "newsletter", "poem", "speech"].includes(t)],
  ["episode", "Episodes", (t) => t === "podcast episode" || t === "podcast"],
  ["other", "Everything else", (t) => !["book", "essay", "article", "paper", "newsletter", "poem", "speech", "podcast episode", "podcast"].includes(t)],
];
const JACKETS = {   // ink, paper: a few riso inks, chosen by the work's kind
  book: [["#3F6FC6", "#F6F1E7"], ["#2C9887", "#F6F1E7"], ["#232736", "#F5C232"], ["#EC5B42", "#F6F1E7"]],
  read: [["#EDE5D4", "#232736"], ["#F5C232", "#232736"], ["#EE7BA8", "#232736"]],
  episode: [["#232736", "#F6F1E7"]],
  satu: [["#F5C232", "#232736"]],
  other: [["#DDD1BA", "#232736"]],
};

function shelfKind(t) { return SHELF_KINDS.slice(1).find(([, , f]) => f(t))?.[0] ?? "other"; }

function jacket(it, work) {
  const k = shelfKind(it.type);
  const show = it.item.match(/\(Episode (\d+) of (Everything is Everything|The Seen and the Unseen)/);
  const palette = show?.[2] === "The Seen and the Unseen" ? JACKETS.satu : JACKETS[k] || JACKETS.other;
  const seed = hash(work?.id || it.item);
  const [bg, ink] = palette[seed % palette.length];
  const title = show ? it.item.replace(/\s*\(Episode.*$/, "") : work?.title || it.item;
  const creator = show ? "" : it.creator || work?.creator || "";
  const b = h("button", {
    type: "button", class: `jacket${show ? " ep" : ""}`, style: { "--j-bg": bg, "--j-ink": ink },
    "aria-expanded": "false", "aria-label": `${title}${creator ? `, by ${creator}` : ""}: why they recommend it`,
  });
  b.append(h("span", { class: "motif", html: motif(k, seed, ink, show) }));
  if (show) {
    b.append(h("span", { class: "kind" }, show[2]), h("span", { class: "bignum t" }, show[1]), h("span", { class: "title" }, title));
  } else {
    b.append(h("span", { class: "kind" }, it.type[0].toUpperCase() + it.type.slice(1)), h("span", { class: "title" }, title), h("span", { class: "by" }, creator));
  }
  return b;
}

/* A quiet geometric motif behind each jacket, different for every work, drawn from its name. */
function motif(kind, seed, ink, show) {
  const r = (n) => (seed >> n) & 255;
  if (show) return `<svg viewBox="0 0 100 150" preserveAspectRatio="none" aria-hidden="true"><circle cx="78" cy="128" r="30" fill="#D4522F" opacity=".9"/><circle cx="98" cy="128" r="30" fill="#2B5BA6" opacity=".9" style="mix-blend-mode:screen"/></svg>`;
  if (kind === "book") {
    const cx = 20 + (r(3) % 60), cy = 70 + (r(11) % 60), rad = 26 + (r(19) % 22);
    return `<svg viewBox="0 0 100 150" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${rad}" fill="${ink}" opacity=".16"/><rect x="0" y="${118 + (r(7) % 12)}" width="100" height="5" fill="${ink}" opacity=".3"/></svg>`;
  }
  if (kind === "read") {
    const y = 96 + (r(5) % 20);
    return `<svg viewBox="0 0 100 150" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<rect x="10" y="${y + i * 7}" width="${40 + ((r(i * 3) % 40))}" height="2.4" fill="${ink}" opacity=".35"/>`).join("")}</svg>`;
  }
  return `<svg viewBox="0 0 100 150" aria-hidden="true"><path d="M0 ${110 + (r(4) % 20)}l100 -${20 + (r(9) % 30)}V150H0z" fill="${ink}" opacity=".12"/></svg>`;
}

function renderShelf() {
  const sec = $("#shelf");
  const recs = D.items.filter((i) => i.id[4] === "R");
  sec.append(secHead("shelf", "The shelf", recs.length, "Everything they recommended, and why it's worth your time."));
  const counts = Object.fromEntries(SHELF_KINDS.map(([k]) => [k, k === "all" ? recs.length : recs.filter((r) => shelfKind(r.type) === k).length]));
  const filters = h("div", { class: "filters", role: "group", "aria-label": "Show" },
    SHELF_KINDS.filter(([k]) => counts[k]).map(([k, label]) => h("button", {
      type: "button", "aria-pressed": String(k === "all"), "data-k": k,
      onclick: (ev) => {
        $$(".filters button", sec).forEach((b) => b.setAttribute("aria-pressed", String(b === ev.currentTarget)));
        Shelf.close();
        $$(".work", sec).forEach((w) => { w.hidden = k !== "all" && w.dataset.k !== k; });
      },
    }, label, h("span", { class: "n t" }, String(counts[k])))));
  const shelf = h("div", { class: "shelf" });
  for (const it of recs) {
    const work = D.works[it.work];
    const j = jacket(it, work);
    const n = work?.episodes.length ?? 1;
    const card = h("div", { class: "work", id: it.id, "data-k": shelfKind(it.type) }, j,
      h("div", { class: "meta" },
        h("span", { class: "who", "data-s": NAMES.indexOf(it.recommender) }, FIRST[NAMES.indexOf(it.recommender)] ?? it.recommender),
        n > 1 ? h("span", { class: "tally", "aria-hidden": "true" }, Array.from({ length: Math.min(n, 30) }, () => h("i"))) : null,
        n > 1 ? h("span", { class: "label t" }, `${n} episodes`) : null));
    j.addEventListener("click", () => Shelf.toggle(card, it, work, j));
    shelf.append(card);
  }
  sec.append(filters, shelf);
}

const Shelf = {
  open: null,
  close() { $(".work-detail")?.remove(); this.open?.setAttribute("aria-expanded", "false"); this.open = null; },
  toggle(card, it, work, j) {
    const same = this.open === j;
    this.close();
    if (same) return;
    // The detail opens under the clicked jacket's row, not at the end of the shelf.
    const sideways = getComputedStyle(card.parentNode).gridAutoFlow.startsWith("column");
    const row = $$(".work:not([hidden])", card.parentNode).filter((w) => w.offsetTop === card.offsetTop);
    const anchor = sideways ? card.parentNode : row[row.length - 1];
    const others = (work?.episodes || []).filter((n) => n !== EP);
    const linked = it.ep && A.episodes.find((e) => e.n === it.ep);
    const detail = h("div", { class: "work-detail", role: "region", "aria-label": `About ${work?.title || it.item}` },
      h("div", {},
        h("h3", {}, work?.title || it.item),
        h("p", { class: "by" }, [it.creator || work?.creator, it.type].filter(Boolean).join(" · ")),
        h("p", {}, others.length ? work.why : it.reason),
        h("p", { class: "label" }, `Recommended here by ${it.recommender}. ${it.context}`),
        h("div", { class: "row" },
          it.clip ? chip(here(it), { text: "Where it comes up", len: clock(it.at[0]), label: `Hear where it comes up, at ${clock(it.at[0])}` })
            : h("span", { class: "notes-only" }, "Not said aloud: it's in the show notes."),
          it.url ? h("a", { class: "pill", href: it.url, target: "_blank", rel: "noopener" }, domain(it.url), h("span", { "aria-hidden": "true" }, " ↗")) : null,
          linked ? chip({ ...linked.moment, ep: linked.n, videoId: linked.videoId }, { text: `Hear Episode ${linked.n}`, label: `Hear a moment from Episode ${linked.n}, ${linked.title}` }) : null)),
      others.length ? h("div", {},
        h("p", { class: "label" }, `Also recommended in ${plural(others.length, "other episode")}`),
        h("ul", {}, others.slice(0, 12).map((n) => {
          const heard = work.mentions?.find((x) => x.ep === n && x.clip);
          return h("li", {}, h("span", { class: "label t" }, `Ep ${n}`), D.titles[n], " ",
            heard ? chip({ ...heard, videoId: videoOf(n), title: `${work.title}, in Episode ${n}` }, { label: `Hear it come up in Episode ${n}, at ${clock(heard.at[0])}` }) : null);
        }),
          others.length > 12 ? h("li", { class: "label" }, `and ${others.length - 12} more`) : null)) : null);
    anchor.after(detail);
    j.setAttribute("aria-expanded", "true");
    this.open = j;
  },
};

/* ── laughs ───────────────────────────────────────────────── */

function renderLaughs() {
  const sec = $("#laughs");
  const all = D.items.filter((i) => i.id[4] === "J").sort((a, b) => (a.at?.[0] ?? 0) - (b.at?.[0] ?? 0));
  const funny = all.filter((j) => j.type === "humor").length;
  sec.append(secHead("laughs", "Laughs", all.length, `${funny} funny moments and ${all.length - funny} names they drop, in the order they happened.`));
  sec.append(h("div", { class: "laughs" }, all.map((it) => h("article", { class: `laugh${it.type === "reference" ? " ref" : ""}`, id: it.id },
    it.type === "reference"
      ? h("span", { class: "label ref-mark" }, h("span", { "aria-hidden": "true", html: GLYPHS.R }), "Reference")
      : h("span", { class: "glyph", "aria-hidden": "true" }, "“"),
    it.type === "reference" ? null : h("span", { class: "sr-only" }, "Joke: "),
    h("p", {}, it.content),
    h("div", { class: "row" }, chip(here(it)))))));
}

/* ── remember: retrieval practice, spaced ─────────────────── */

// Days until the next look. Knowing it stretches the gap 2.5×, from 3 days (3, 8, 20, 50…); hazy
// stretches it a little; forgetting brings it back tomorrow. (Fixed boxes made all three answers
// read "tomorrow" on a new card, so knowing it never spaced it out.)
const NEXT = { forgot: () => 1, hazy: (d) => Math.max(2, Math.round(d * 1.2)), knew: (d) => Math.max(3, Math.round(d * 2.5)) };

const Practice = {
  cards: [], i: 0, flipped: false, results: [],
  today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
  iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
  state() { return store.get("eie.cards", {}); },
  pool() {
    // The episode's spine (the first idea of each chapter), every story, and anything you kept.
    const ids = [...keyIdeas().map((i) => i.id), ...D.items.filter((i) => i.id[4] === "S").map((i) => i.id), ...kept];
    return [...new Set(ids)].map((id) => D.items.find((i) => i.id === id)).filter((it) => it && D.art?.[it.id]);
  },
  due() {
    const st = this.state(), today = this.iso(this.today());
    return this.pool().filter((it) => st[it.id] && st[it.id].due <= today);
  },
  deck() {
    const st = this.state();
    const fresh = this.pool().filter((it) => !st[it.id]);
    return [...this.due(), ...fresh].slice(0, 7);
  },
  render() {
    const sec = $("#remember");
    sec.append(secHead("remember", "Remember", null, "Recalling something is what fixes it. Look at the picture, say the idea out loud, then check."));
    this.flash = h("div", { class: "flash", "aria-live": "polite" });
    this.memory = h("div", { class: "memory" });
    sec.append(h("div", { class: "practice" }, this.flash, this.memory));
    this.start();
  },
  start() { this.cards = this.deck(); this.i = 0; this.flipped = false; this.results = []; this.draw(); this.side(); },
  refresh() { if (!this.cards.length || this.i >= this.cards.length) this.start(); this.side(); badge(); },
  draw() {
    const f = this.flash;
    put(f);
    if (!this.cards.length || this.i >= this.cards.length) {
      const next = this.nextDates()[0];
      f.append(h("div", { class: "done" },
        h("h3", { tabindex: "-1" }, this.results.length ? "That's the lot for today." : "Nothing to recall today."),
        h("p", {}, next ? `The next ones come back ${next.when}. Each one you know comes back later every time: in 3 days, then 8, then 20, then 50.`
          : "Keep a few ideas or stories and they'll join the deck."),
        this.results.length ? h("button", { type: "button", class: "pill", onclick: () => this.start() }, "Go again") : null));
      return;
    }
    const it = this.cards[this.i];
    const isStory = it.id[4] === "S";
    f.append(h("div", { class: "progress", "aria-label": `Card ${this.i + 1} of ${this.cards.length}` },
      this.cards.map((_, k) => h("i", { "data-done": k < this.i || null, "data-now": k === this.i || null }))));
    f.append(plate(it.id, titleOf(it)));
    if (!this.flipped) {
      f.append(h("p", { class: "prompt" }, isStory ? "What happened here, and what does it teach?" : "What's the idea in this picture?"),
        h("button", { type: "button", class: "reveal", onclick: () => { this.flipped = true; this.draw(); $(".grade button", f)?.focus(); } }, "Show me"));
      return;
    }
    const gap = this.state()[it.id]?.gap ?? 0;
    const whenFor = (n) => (n === 1 ? "tomorrow" : `in ${n} days`);
    f.append(h("div", { class: "answer" },
      h("h3", {}, titleOf(it)),
      h("p", {}, isStory ? it.insight : it.explanation),
      h("div", { class: "row" }, chip(here(it)))),
      h("div", { class: "grade", role: "group", "aria-label": "How well did you remember it?" },
        [["Forgot", "forgot"], ["Hazy", "hazy"], ["Knew it", "knew"]].map(([label, k]) => {
          const days = NEXT[k](gap);
          return h("button", { type: "button", onclick: () => this.grade(it, days, label) }, label, h("small", {}, whenFor(days)));
        })));
  },
  grade(it, days, label) {
    const st = this.state();
    const due = this.today();
    due.setDate(due.getDate() + days);
    st[it.id] = { gap: days, due: this.iso(due) };
    store.set("eie.cards", st);
    this.results.push([it.id, label]);
    this.i++; this.flipped = false;
    this.draw(); this.side(); badge();
    ($(".reveal", this.flash) || $(".done h3", this.flash))?.focus();
  },
  nextDates() {
    const st = this.state(), groups = new Map();
    for (const it of this.pool()) {
      const s = st[it.id];
      if (!s) continue;
      groups.set(s.due, (groups.get(s.due) || 0) + 1);
    }
    const today = this.iso(this.today());
    const tomorrow = new Date(this.today()); tomorrow.setDate(tomorrow.getDate() + 1);
    return [...groups].sort().filter(([d]) => d > today).map(([d, n]) => ({
      d, n, when: d === this.iso(tomorrow) ? "tomorrow" : `on ${day(d)}`,
    }));
  },
  side() {
    const m = this.memory;
    const ahead = this.nextDates();
    put(m, 
      h("h3", {}, "How this works"),
      h("p", {}, "Seven cards at most, a few minutes a day. What you know comes back later each time; what you forget comes back tomorrow. It all stays in this browser."),
      ahead.length ? h("ol", {}, ahead.slice(0, 5).map((x) => h("li", {}, h("b", {}, x.when[0].toUpperCase() + x.when.slice(1)), plural(x.n, "card")))) : null,
      h("p", { class: "label", style: { marginTop: "14px" } }, (() => {
        const inDeck = [...kept].filter((id) => this.pool().some((it) => it.id === id)).length;
        return inDeck ? `${plural(inDeck, "kept idea or story", "kept ideas and stories")} in the deck.` : "Press Keep on any idea or story to add it to the deck.";
      })()),
    );
  },
};

function badge() {
  const n = Practice.due().length;
  const b = $(".due");
  b.hidden = !n;
  b.textContent = n || "";
  b.setAttribute("aria-label", `${n} due`);
}

/* ── onward: big ideas, the thread, the links ─────────────── */

function renderOnward() {
  const sec = $("#onward");
  sec.append(secHead("onward", "Onward", null, "Where this episode leads: the big ideas it feeds, and the episodes around it."));
  const mine = new Set(D.items.map((i) => i.id));
  const grid = h("div", { class: "ideas-grid" });
  for (const b of [...D.bigIdeas].sort((x, y) => y.episodes.length - x.episodes.length)) {
    const src = b.sources.find((s) => mine.has(s.id) && D.art?.[s.id]) || b.sources.find((s) => mine.has(s.id));
    grid.append(h("button", { type: "button", class: "idea-tile", onclick: () => Drawer.open(b.id) },
      plate(src?.id, b.name, true), h("b", {}, b.name),
      h("span", { class: "label t" }, `In ${b.episodes.length} episodes`)));
  }
  sec.append(h("div", { class: "onward-block" }, h("h3", {}, "The big ideas it feeds"),
    h("p", {}, "Each runs through many episodes. Open one to hear the hosts come back to it, year after year."), grid));

  for (const t of D.threads) {
    sec.append(h("div", { class: "onward-block" },
      h("h3", {}, `A listening thread: ${t.name}`),
      h("p", {}, t.summary),
      h("div", { class: "thread", role: "list" }, t.path.map((s, k) => h("div", { class: "station", role: "listitem", "aria-current": s.episode === EP ? "true" : null },
        h("span", { class: "label t" }, `${k + 1} · Episode ${s.episode}`),
        h("b", {}, D.titles[s.episode]),
        h("p", {}, s.why))))));
  }

  const list = (ns) => h("ul", {}, ns.map((n) => {
    const e = A.episodes.find((x) => x.n === n);
    return h("li", {}, h("span", { class: "t" }, String(n)), h("span", {}, e.title, " ",
      chip({ ...e.moment, ep: n, videoId: e.videoId }, { text: "Hear it", label: `Hear a moment from Episode ${n}, ${e.title}` })));
  }));
  sec.append(h("div", { class: "onward-block" },
    h("h3", {}, "Episodes on either side"),
    h("p", {}, "The show notes link back to earlier episodes. These are the ones this episode builds on, and the ones that came back to it."),
    h("div", { class: "links" },
      h("div", {}, h("p", { class: "label" }, `It builds on ${plural(D.episode.linksTo.length, "episode")}`), list(D.episode.linksTo)),
      h("div", {}, h("p", { class: "label" }, `${plural(D.episode.linkedFrom.length, "later episode")} came back to it`), list(D.episode.linkedFrom)))));
}

const Drawer = {
  last: null,
  open(bid) {
    const b = D.bigIdeas.find((x) => x.id === bid);
    const d = $("#drawer"), scrim = $(".drawer-scrim");
    this.last = document.activeElement;
    const mine = new Set(D.items.map((i) => i.id));
    const src = b.sources.find((s) => mine.has(s.id) && D.art?.[s.id]);
    const byEp = new Map();
    for (const s of b.sources) byEp.set(s.ep, [...(byEp.get(s.ep) || []), s]);
    put(d, 
      h("button", { type: "button", class: "icon-btn close", "aria-label": "Close", onclick: () => this.close(), html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
      h("span", { class: "label t" }, `A big idea · in ${b.episodes.length} episodes`),
      h("h2", { id: "drawer-title" }, b.name),
      src ? plate(src.id, b.name) : null,
      h("p", { class: "lede" }, b.summary),
      h("p", { class: "why" }, h("span", { class: "label", style: { display: "block" } }, "Why it matters"), b.why),
      b.thinkers?.length ? h("p", { class: "label" }, `Thinkers: ${b.thinkers.join(", ")}`) : null,
      h("h3", {}, "Hear it across the show"),
      h("p", { class: "label" }, `${plural(b.sources.length, "moment")} from ${plural(byEp.size, "episode")}, in the order they aired.`),
      [...byEp].sort((x, y) => x[0] - y[0]).flatMap(([ep, ss]) => ss.map((s) => h("div", { class: `src${ep === EP ? " here" : ""}` },
        h("span", { class: "label t" }, ep === EP ? `This episode · ${clock(s.at?.[0] ?? 0)}` : `Episode ${ep} · ${D.titles[ep]}`),
        h("b", {}, s.title),
        s.quote ? h("q", {}, s.quote) : null,
        chip({ ...s, videoId: videoOf(ep) })))),
    );
    d.hidden = false; scrim.hidden = false;
    d.scrollTop = 0;
    document.body.style.overflow = "hidden";
    $(".close", d).focus();
    scrim.onclick = () => this.close();
  },
  close() {
    $("#drawer").hidden = true; $(".drawer-scrim").hidden = true;
    document.body.style.overflow = "";
    this.last?.focus?.();
  },
  get isOpen() { return !$("#drawer").hidden; },
};

/* ── footer ───────────────────────────────────────────────── */

function renderFoot() {
  const f = D.episode.fetched;
  $(".foot").append(
    h("div", {}, h("h3", {}, "The show"),
      h("p", {}, "Everything is Everything was Amit Varma and Ajay Shah's weekly show, 128 episodes from June 2023 to December 2025. Every moment here plays from its YouTube video."),
      h("p", {}, h("a", { href: "https://www.youtube.com/@amitvarma", target: "_blank", rel: "noopener" }, "The channel ↗"))),
    h("div", {}, h("h3", {}, "How this was made"),
      h("p", {}, "The transcript is machine-made, with every word named by voice. The ideas, stories and books were drawn from it by Claude and checked against it, and every moment was found by its words, so it starts where the line does."),
      h("p", { class: "label" }, `Views and chapters as of ${day(f)}.`)),
    h("div", {}, h("h3", {}, "The pictures"),
      h("p", {}, "Drawn in the manner of ISOTYPE, the picture language Otto Neurath and Gerd Arntz made in 1920s Vienna to show social and economic facts to everyone, and printed here as if by risograph."),
      h("p", {}, h("a", { href: "https://github.com/rounakdatta/eie", target: "_blank", rel: "noopener" }, "The data ↗"))),
  );
}

/* ── page chrome: theme, bar, sections, keys ──────────────── */

function wireChrome() {
  const root = document.documentElement, btn = $(".theme");
  const dark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const label = () => btn.setAttribute("aria-label", dark() ? "Switch to the light theme" : "Switch to the dark theme");
  label();
  btn.addEventListener("click", () => { root.dataset.theme = dark() ? "light" : "dark"; try { localStorage.setItem("eie.theme", root.dataset.theme); } catch {} label(); });

  const bar = $("#bar");
  addEventListener("scroll", () => bar.classList.toggle("scrolled", scrollY > 8), { passive: true });

  const links = $$(".sections a");
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target.id, e.isIntersecting);
    const current = links.find((a) => seen.get(a.getAttribute("href").slice(1)));
    links.forEach((a) => a.setAttribute("aria-current", String(a === current)));
    const nav = $(".sections");
    if (current && nav.scrollWidth > nav.clientWidth) {
      const x = current.offsetLeft - nav.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
      nav.scrollTo({ left: x, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  $$(".sec").forEach((s) => io.observe(s));

  $(".dock-close").addEventListener("click", (ev) => {
    // Focus goes back to what started playback only when it was in the dock and the close came from
    // the keyboard; then it may scroll, so a keyboard user sees where they are. A click or tap focuses
    // the × too, and refocusing then threw a reader 17,000 px back; Esc works from anywhere, and
    // moving focus then made the next Space restart the reel.
    // How focus got into the dock decides it, not how the dock closed: Chrome leaves focus on a
    // button clicked with the mouse, and Esc closes through a click with no pointer either.
    const keyboardInDock = $("#dock").contains(document.activeElement) && Dock.keyboard;
    const origin = Player.origin;
    Player.close();
    $("#dock").hidden = true;
    document.body.classList.remove("docked");
    if (ev.detail === 0 && keyboardInDock && origin?.isConnected) origin.focus();
  });
  $("#dock").addEventListener("focusin", (ev) => { Dock.keyboard = ev.target.matches(":focus-visible"); });
  $(".dock-replay").addEventListener("click", () => Player.replay());
  $(".dock-toggle").addEventListener("click", () => Player.toggle());
  $(".dock-more").addEventListener("click", () => Player.more());

  addEventListener("keydown", (ev) => {
    if (ev.target.closest("input, textarea, [contenteditable]") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "Escape") {
      if (Drawer.isOpen) return Drawer.close();
      if (!$("#dock").hidden) return $(".dock-close").click();
    }
    if ($("#dock").hidden) return;
    const k = ev.key.toLowerCase();
    if (k === "k") { ev.preventDefault(); Player.toggle(); }
    if (k === "j") { ev.preventDefault(); Player.seek(-10); }
    if (k === "l") { ev.preventDefault(); Player.seek(10); }
  });
  document.addEventListener("keydown", (ev) => {   // keep focus inside the open drawer
    if (ev.key !== "Tab" || !Drawer.isOpen) return;
    const d = $("#drawer"), f = $$("button, a[href]", d);
    const at = document.activeElement;
    if (!d.contains(at) || at === d) { ev.preventDefault(); (ev.shiftKey ? f[f.length - 1] : f[0]).focus(); }
    else if (ev.shiftKey && at === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && at === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
  });

  // A link to a card (#045-C03) or a section lands on it and says so. On first load the browser
  // looked for it before the data had built it, and stayed at the top; so scroll there ourselves.
  const land = (initial) => {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    if (initial === true) el.scrollIntoView({ block: "start" });
    if (el.matches(".card, .story, .laugh, .work")) { el.classList.remove("flash-target"); void el.offsetWidth; el.classList.add("flash-target"); }
  };
  addEventListener("hashchange", () => land(false));
  land(true);
}

/* ── start ────────────────────────────────────────────────── */

async function main() {
  const [d, a, sprite] = await Promise.all([
    fetch(`data/${String(EP).padStart(3, "0")}.json`).then((r) => r.json()),
    fetch("data/archive.json").then((r) => r.json()),
    fetch("art/sprite.svg").then((r) => r.text()),
  ]);
  D = d; A = a;
  $("#sprite").innerHTML = sprite;
  // Words arrive as centisecond deltas; make them absolute once.
  let t = 0;
  WORDS = { t: d.words.t.map((x) => (t += x)), w: d.words.w, s: d.words.s };
  renderRibbon();
  renderMasthead();
  Strip.render();
  renderIdeas();
  renderStories();
  renderShelf();
  renderLaughs();
  Practice.render();
  renderOnward();
  renderFoot();
  wireChrome();
  badge();
  window.__eie = { Player };   // for the checks in tools/checks.cjs
  document.documentElement.dataset.ready = "true";
}

main().catch((e) => {
  console.error(e);
  document.querySelector("main").prepend(h("p", { class: "wrap" }, "This page couldn't load its data. If you opened the file directly, serve the folder over http instead (python3 -m http.server)."));
});
