// The newsreel: the archive's moments one to a screen, each played from the second it was said.
//
// The feed is a native scroller that snaps one reel at a time (reels.css), so touch, trackpad, wheel and
// keys all move it with the platform's own physics. It holds five recycled slots, whatever the reel's
// length, and three YouTube players laid over whichever slots they serve: the reel on screen, the next
// one (cued at its first second, so it starts the moment it arrives) and the one before (so going back
// is instant). A player is never moved in the page (an iframe moved is an iframe reloaded); it is
// positioned over its slot instead.
//
// A clip ends where its last word ends. YouTube's `end` parameter has whole seconds only, and
// getCurrentTime() moves in steps (the player reports it a few times a second), so the reel keeps its
// own clock between reports and stops the film itself, after a short fade, on the word's tail.
//
// The feed is ../search/reels.py, beside the archive's search on eie.taptappers.club: it answers 503
// {"off": true} when the reel is switched off, and the reel then says so and points back to the paper.

const $ = (s, r = document) => r.querySelector(s);
const HOME = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) || location.hostname === "eie.taptappers.club";
const API = HOME ? "/api/reels" : "https://eie.taptappers.club/api/reels";
const SITE = new URL("../", location.href).href;   // the archive: editions at SITE + "45/"
const PUBLIC = "https://eie.taptappers.club/reels/";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const SLOTS = 5, FRAMES = 3;
const WHO = ["Amit Varma", "Ajay Shah", ""];
const FIRST = ["Amit", "Ajay", ""];
const INK = ["var(--amit)", "var(--ajay)", "var(--other)"];
const KIND = { S: "A story", C: "An idea", R: "Recommended", J: "A laugh" };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
}
function clock(cs) {
  const s = Math.floor(cs / 100), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
const fmt = (n) => n.toLocaleString("en-IN");
const day = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const kindOf = (x) => (x.k === "J" && x.type === "reference" ? "A reference" : x.k === "R" && x.type ? `Recommended: a ${x.type}` : KIND[x.k]);
const youtube = (x, at = x.clip[0]) => `https://www.youtube.com/watch?v=${x.v}&t=${Math.floor(at / 100)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── state ─────────────────────────────────────────────────────────────── */

const feed = $("#feed"), track = $("#track"), list = $("#list"), films = $("#films");
const S = {
  items: [], base: 0, total: 0, next: 0, name: "", lead: false, filters: {}, from: null, loading: null, off: false, failed: false,
  cur: -1, H: 0, slots: [], frames: [], api: null,
  sound: store.get("eie.reel.sound", false), playOn: store.get("eie.reel.on", true),
  gen: 0, touching: false, stayed: false, unattended: 0, ended: false, paused: false, free: false, advance: 0, stall: 0, watch: 0, raf: 0,
  timing: [],   // for the checks: how long each reel took to move, and where each clip stopped
};
window.__reel = S;

function readUrl() {
  const p = new URLSearchParams(location.search);
  S.filters = {};
  for (const k of ["ep", "kind", "who", "idea", "q"]) if (p.get(k)) S.filters[k] = p.get(k).slice(0, 120);
  S.from = p.get("n");
  // the newsreel unfiltered picks up after the last moment this reader saw, unless a link says where
  S.startAt = !S.from && !Object.keys(S.filters).length ? store.get("eie.reel.pos", -1) + 1 : 0;
  // the way back: to the edition this reel came from, or the page that sent the reader here
  const back = $("#back");
  const ref = document.referrer && new URL(document.referrer).origin === location.origin ? document.referrer : null;
  if (S.filters.ep) { back.href = `${SITE}${S.filters.ep}/`; back.lastChild.replaceChildren(`No. ${S.filters.ep}`); }
  else if (ref && !ref.includes("/reels/")) back.href = ref;
}
function urlFor(x) {
  const p = new URLSearchParams(S.filters);
  if (x) p.set("n", x.id);
  return `${location.pathname}?${p}`;
}

/* ── the feed's pages ───────────────────────────────────────────────────── */

async function load(more = false) {
  if (S.loading) return S.loading;
  if (more && S.next == null) return;
  const gen = S.gen;
  const p = new URLSearchParams(S.filters);
  if (more) p.set("at", S.next); else if (S.from) p.set("from", S.from); else if (S.startAt > 0) p.set("at", S.startAt);
  p.set("n", more ? 10 : 6);
  S.loading = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${API}?${p}`);
        if (gen !== S.gen) return;   // a reel since replaced (a filter chosen meanwhile)
        if (r.status === 503) { S.off = true; return; }
        if (r.status === 429 && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (gen !== S.gen) return;
        if (!more && !d.items.length && S.startAt > 0) { S.startAt = 0; p.delete("at"); continue; }   // seen it all: from the top
        if (!more) { S.name = d.name; S.total = d.total; S.base = d.at - (d.lead ? 1 : 0); S.lead = !!d.lead; }
        S.next = d.next;
        S.items.push(...d.items);
        S.failed = false;
        return;
      } catch (e) {
        if (gen !== S.gen) return;
        if (attempt >= 2) { S.failed = true; return; }
        await sleep(1200 * (attempt + 1));
      }
    }
  })().finally(() => { if (gen === S.gen) S.loading = null; });
  return S.loading;
}

/* ── slots: five articles, recycled as the reel moves ─────────────────────── */

const count = () => S.items.length + (S.next == null || S.failed ? 1 : 0);   // and the end, once there is one

function makeSlots() {
  for (let k = 0; k < SLOTS; k++) {
    const el = h("article", { class: "reel", "aria-posinset": "", "aria-setsize": "", tabindex: "-1" });
    el.dataset.i = "-1";
    S.slots.push(el);
    list.append(el);
  }
}
const slotOf = (i) => S.slots.find((s) => +s.dataset.i === i);

function fill(slot, i) {
  slot.dataset.i = String(i);
  slot.style.top = `${i * S.H}px`;
  slot.replaceChildren();
  slot.removeAttribute("data-k");
  slot.className = "reel";
  if (i >= S.items.length) return fillEnd(slot, i);
  const x = S.items[i];
  slot.dataset.k = x.k;
  slot.dataset.state = "cued";
  slot.style.setProperty("--c", INK[x.spk] || INK[2]);
  slot.setAttribute("aria-posinset", String(Math.max(1, S.base + i + 1)));
  slot.setAttribute("aria-setsize", String(S.total));
  slot.setAttribute("aria-labelledby", `h-${x.id}`);
  const who = WHO[x.spk] || "";
  const at = x.clip[0];
  const said = h("p", { class: "said", "aria-hidden": "true" });
  x.words.forEach(([, w], k) => { said.append(h("span", { class: "w", "data-k": k }, w), " "); });
  const quote = x.words.map(([, w]) => w).join(" ");
  const paper = `${SITE}${x.ep}/${x.paper ? `#${x.paper}` : ""}`;
  const cover = x.cover ? h("img", { class: "cover", src: `${SITE}covers/${x.cover[0]}`, alt: `The cover of ${x.head}`, width: x.cover[1], height: x.cover[2], decoding: "async" }) : null;
  const head = h("h2", { class: "head", id: `h-${x.id}` }, x.head || "");
  const by = x.by ? h("p", { class: "by" }, x.by) : null;
  // why it matters: its first sentence or two on a phone, the whole of it where there is room
  const long = { S: x.more?.[1], C: x.more?.[0], R: x.more?.[0] }[x.k] || x.dek;
  const dek = x.dek ? h("p", { class: "dek" }, h("span", { class: "short" }, x.dek), h("span", { class: "long" }, long)) : null;
  const inner = h("div", { class: "inner" },
    h("div", { class: "text" },
      h("p", { class: "kicker" }, h("span", { class: "dot", "aria-hidden": "true" }), kindOf(x), who ? h("span", { class: "who" }, `· ${who}`) : null),
      x.k === "R" ? h("div", { class: "titled" }, h("div", {}, head, by), cover) : head,
      dek,
      h("p", { class: "src" },
        h("a", { class: "ed", href: paper, title: x.printed ? `Printed as “${x.printed}”` : null },
          h("b", {}, `No. ${x.ep}`), ` · ${x.edition}`),
        (x.more || []).some(Boolean) ? h("button", { type: "button", class: "all", onclick: () => whole(i) }, x.k === "S" ? "The whole story" : "Read more") : null)),
    h("div", { class: "media" },
      // the film, and nothing over it (YouTube's rule, and ours): the edition's own frame of this
      // speaker lies under it only until YouTube's player has drawn itself
      h("div", { class: "screen" },
        h("img", { src: `${SITE}${x.ep}/media/${x.poster}`, alt: "", decoding: "async", fetchpriority: i === S.cur ? "high" : "low" })),
      h("p", { class: "foot" },
        h("span", { class: "bar-p", "aria-hidden": "true" }),
        h("span", { class: "t" }, `${day(x.date)} · ${clock(at)}`),
        h("a", { href: youtube(x), target: "_blank", rel: "noopener" }, "Watch on YouTube ↗")),
      said,
      h("p", { class: "sr-only" }, `${who || "They"} said: “${quote}”`)));
  slot.append(inner);
  sized.observe(inner);
  fit(slot);
}

/* Step a reel's words down until they fit its screen (reels.css: data-fit), and say how far it went. */
function fit(slot) {
  const inner = slot.querySelector(".inner");
  if (!inner || !S.H) return;
  const cs = getComputedStyle(slot), room = S.H - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  let k = 0;
  slot.dataset.fit = "0";
  while (inner.offsetHeight > room + 0.5 && k < 4) slot.dataset.fit = String(++k);
}

function fillEnd(slot, i) {
  slot.classList.add("end");
  slot.dataset.state = "end";
  slot.removeAttribute("aria-labelledby");
  const filtered = Object.keys(S.filters).length > 0;
  const head = S.failed ? "The reel stopped loading" : `That’s the reel`;
  const line = S.failed ? "The connection dropped. The moments so far are all still here." :
    `${fmt(S.total)} ${S.total === 1 ? "moment" : "moments"}${filtered ? ` in ${S.name}` : ""}.`;
  slot.append(h("div", { class: "inner" },
    h("h2", { id: "h-end" }, head),
    h("p", {}, line),
    h("div", { class: "ways" },
      S.failed ? h("button", { type: "button", class: "first", onclick: () => { S.failed = false; load(true).then(more); } }, "Try again") : null,
      !S.failed ? h("button", { type: "button", class: "first", onclick: () => (S.base > 0 || S.lead ? restart({ ...S.filters }) : scrollToI(0)) }, "From the top") : null,
      filtered ? h("a", { href: location.pathname + "?" }, "The whole newsreel") : null,
      h("a", { href: SITE }, "The paper")),
    terms()));
  slot.setAttribute("aria-labelledby", "h-end");
}

const sized = new ResizeObserver(() => placeFrames());
document.fonts?.ready.then(() => { for (const s of S.slots) if (+s.dataset.i >= 0) fit(s); placeFrames(); });

/* Lay the slots over reels around (the current one, unless a jump is about to land elsewhere), size
   the track, and place the players. */
function layout(around = S.cur) {
  S.H = feed.clientHeight;
  document.documentElement.style.setProperty("--h", `${S.H}px`);
  const n = count();
  track.style.height = `${n * S.H}px`;
  list.setAttribute("aria-busy", String(!!S.loading));
  const want = [];
  for (let i = Math.max(0, around - 2); i < Math.min(n, Math.max(0, around - 2) + SLOTS); i++) want.push(i);
  const free = S.slots.filter((s) => !want.includes(+s.dataset.i));
  for (const i of want) {
    let s = slotOf(i);
    if (!s || (i >= S.items.length) !== s.classList.contains("end")) { s = s || free.shift(); fill(s, i); }
    else { s.style.top = `${i * S.H}px`; if (S.H !== S.fitH) fit(s); }
  }
  S.fitH = S.H;
  for (const s of free) { s.dataset.i = "-1"; s.style.top = "-9999px"; s.replaceChildren(); }
  placeFrames();
}

/* ── the players ──────────────────────────────────────────────────────────── */

function api() {
  // the script once, and a page whose script never comes still reads: the reels show their posters
  if (window.YT?.Player) return Promise.resolve();
  S.api ||= new Promise((resolve, reject) => {
    const was = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { was?.(); resolve(); };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = h("script", { src: "https://www.youtube.com/iframe_api", async: true });
      s.onerror = () => { s.remove(); reject(new Error("blocked")); };
      document.head.append(s);
    }
    setTimeout(() => (window.YT?.Player ? resolve() : reject(new Error("timeout"))), 15000);
  }).catch((e) => { S.api = null; throw e; });
  return S.api;
}

function makeFrame(k) {
  const el = h("div", { class: "frame", "data-k": k });
  const mount = h("div");
  el.append(mount);
  films.append(el);
  const f = { k, el, mount, yt: null, ready: null, item: -1, video: null, state: -1, lastV: 0, lastW: 0, target: null, errored: 0 };
  return f;
}

function player(f, x) {
  if (f.ready) return f.ready;
  f.ready = api().then(() => new Promise((resolve, reject) => {
    const late = setTimeout(() => { try { f.yt?.destroy?.(); } catch {} f.yt = null; f.mount = f.el.appendChild(h("div")); reject(new Error("no answer")); }, 20000);
    f.yt = new YT.Player(f.mount, {
      host: "https://www.youtube-nocookie.com", width: "100%", height: "100%", videoId: x.v,
      playerVars: { autoplay: 0, controls: 0, playsinline: 1, rel: 0, iv_load_policy: 3, cc_load_policy: 0, disablekb: 1, fs: 0,
        start: Math.floor(x.clip[0] / 100), mute: S.sound ? 0 : 1, origin: location.origin },
      events: {
        onReady: () => { clearTimeout(late); f.video = x.v; resolve(f); },
        onStateChange: (e) => stateChange(f, e.data),
        onError: (e) => playError(f, e.data),
        onAutoplayBlocked: () => blocked(f),
      },
    });
  }));
  f.ready.catch(() => { f.ready = null; });
  return f.ready;
}

const frameOf = (i) => S.frames.find((f) => f.item === i);

/* The players serve the reel on screen, the next, and the one before, in that order of need. */
function assign() {
  const want = [S.cur, S.cur + 1, S.cur - 1].filter((i) => i >= 0 && i < S.items.length);
  const spare = S.frames.filter((f) => !want.includes(f.item));
  for (const i of want) {
    if (frameOf(i)) continue;
    const f = spare.shift();
    if (!f) break;
    f.item = i;
    prepare(f, S.items[i], i !== S.cur);
  }
  placeFrames();
}

function placeFrames() {
  const t = track.getBoundingClientRect();
  for (const f of S.frames) {
    const s = f.item >= 0 && slotOf(f.item);
    const screen = s && s.querySelector(".screen");
    if (!screen) { f.el.style.width = "0px"; f.el.style.height = "0px"; continue; }
    const r = screen.getBoundingClientRect();
    f.el.style.transform = `translate(${r.left - t.left}px, ${r.top - t.top}px)`;
    f.el.style.width = `${r.width}px`;
    f.el.style.height = `${r.height}px`;
  }
}

/* A player made ready for a reel: its film at the clip's first second, cued (not playing). */
async function prepare(f, x, quiet) {
  try { await player(f, x); } catch { return; }
  if (f.item < 0 || S.items[f.item] !== x) return;
  f.yt.getIframe().title = `Episode ${x.ep}, from ${clock(x.clip[0])}: ${x.head || "a laugh"}`;
  if (!quiet) return;   // the reel on screen: play() loads it
  // A player already holding this film (the next moment of the same episode) is left as it is, and
  // play() seeks it: cueing a player its own film again made it fail with error 5 when played.
  if (f.video === x.v && f.state !== -1) return;
  f.video = x.v;
  f.yt.cueVideoById({ videoId: x.v, startSeconds: x.clip[0] / 100 });
}

/* ── playing a reel ───────────────────────────────────────────────────────── */

async function play(i) {
  const x = S.items[i], f = frameOf(i), slot = slotOf(i);
  if (!x || !f || !slot) return;
  clearTimeout(S.advance); clearInterval(S.stall);
  Object.assign(S, { ended: false, paused: false, free: false, broken: false });
  f.retried = false;
  setBody();
  slot.dataset.state = "starting";
  const t0 = performance.now();
  // from the reader's gesture (a swipe let go, a key, a click) when there was one: the whole wait they feel
  const lead = S.gestureAt && t0 - S.gestureAt < 3000 ? Math.round(t0 - S.gestureAt) : 0;
  S.gestureAt = 0;
  S.timing.push({ id: x.id, t0, lead, moved: null, stopped: null, end: x.clip[1], from: f.state, path: null });
  try { await player(f, x); } catch { return S.cur === i && unplayable(i, "YouTube’s player didn’t load."); }
  await inView(f);
  if (S.cur !== i || frameOf(i) !== f || S.items[i] !== x) return;
  // nothing starts in a hidden tab, under the open sheet, or after the reader paused while it loaded:
  // the film waits at its moment, cued, for the reader
  if (document.hidden || !$("#sheet").hidden || S.paused) {
    if (f.video !== x.v || f.state === -1) { f.video = x.v; f.yt.cueVideoById({ videoId: x.v, startSeconds: x.clip[0] / 100 }); }
    S.paused = true; setBody();
    return;
  }
  const at = x.clip[0] / 100;
  if (S.sound) { f.yt.unMute(); f.yt.setVolume(100); } else f.yt.mute();
  f.target = x.clip[0];
  const rec = S.timing[S.timing.length - 1];
  if (f.video === x.v && f.state !== -1) { rec.path = "seek"; f.yt.seekTo(at, true); f.yt.playVideo(); }
  else { rec.path = "load"; f.video = x.v; f.yt.loadVideoById({ videoId: x.v, startSeconds: at }); }
  watch(i);
  stalled(i, f);
}

/* A film that won't start. A browser refusing to play is told by YouTube's onAutoplayBlocked (blocked()):
   refused with sound, the film plays without it and the sound button says "Tap for sound"; refused even
   so (a phone saving power), it is cued again so YouTube's own play button shows, and the reel says to tap
   it. A start's states can't tell a refusal from a slow network (a normal start also goes buffering,
   unstarted, playing, and on a slow one each step can take seconds), so the timer never touches the
   player: after ten seconds with no picture and no buffering, it only says the film can be tapped. */
function stalled(i, f) {
  clearInterval(S.stall);
  const since = performance.now();
  f.buffered = f.nudged = false;
  S.stall = setInterval(() => {
    if (S.cur !== i || S.paused || S.ended || f.state === 1) return clearInterval(S.stall);
    // A start that buffered, then came to rest unstarted with no word from YouTube, is asked once more:
    // seen now and then on a first film, which then never began (playVideo again is harmless if it was
    // only slow; it cancels nothing, unlike cueing again).
    if (!f.nudged && f.buffered && f.state === -1 && performance.now() - (f.changedAt || since) > 2500) { f.nudged = true; f.yt.playVideo(); }
    if (performance.now() - since > 10000 && f.state !== 3) {
      clearInterval(S.stall);
      toast("Tap the film to start it");
    }
  }, 1000);
}

function refused(i, f) {
  const x = S.items[i];
  f.yt.cueVideoById({ videoId: x.v, startSeconds: x.clip[0] / 100 });
  f.target = x.clip[0];
  slotOf(i).dataset.state = "tap";
  S.paused = true; setBody();   // the play button says play: it is not playing
  toast("Tap the film to start it");
}

/* A film starts only once more than half of it is on screen (YouTube's rule for any playback a page
   starts by itself). A reel arrives by a snap, so this is nearly always at once. */
function inView(f) {
  const seen = () => {
    const r = f.el.getBoundingClientRect(), v = feed.getBoundingClientRect();
    const h = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
    return r.height > 0 && h / r.height > 0.5;
  };
  if (seen()) return Promise.resolve();
  return new Promise((resolve) => {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.intersectionRatio > 0.5)) { io.disconnect(); resolve(); } },
      { root: feed, threshold: [0.51] });
    io.observe(f.el);
  });
}

function blocked(f) {
  const rec = S.timing[S.timing.length - 1];
  if (rec) (rec.states ||= []).push([Math.round(performance.now() - rec.t0), "blocked"]);
  if (f.item !== S.cur) return;
  if (f.yt.isMuted()) { clearInterval(S.stall); refused(f.item, f); return; }
  S.blocked = true;   // the browser wants a tap before it plays sound; the reel plays on without it
  f.yt.mute();
  f.yt.playVideo();
  setSound();
}

function stateChange(f, s) {
  f.state = s;
  f.changedAt = performance.now();
  if (s === 3) f.buffered = true;
  if (f.item !== S.cur) { if (s === 1) f.yt.pauseVideo(); return; }   // never a film out of sight
  const rec = S.timing[S.timing.length - 1];
  if (rec && rec.id === S.items[S.cur]?.id) (rec.states ||= []).push([Math.round(performance.now() - rec.t0), s]);
  const slot = slotOf(f.item);
  if (s === 1 && S.ended && !S.free && !S.pausing && !S.broken) {
    // the reader tapped the film after its clip ended (a tap there never reaches the page): listening on
    S.free = true; S.ended = false; S.stayed = true; clearTimeout(S.advance);
    slot && (slot.dataset.state = "free");
    slot?.querySelector(".foot").style.setProperty("--p", "0");
    setBody();
  }
  if (s === 1) {
    for (const m of ["captions", "cc"]) f.yt.unloadModule?.(m);   // the reel draws its own words
    if (slot && slot.dataset.state !== "free") slot.dataset.state = "playing";
    if (S.paused) { S.paused = false; setBody(); }
    setSound();
  }
  if (s === 2 && !S.ended && !S.pausing) {   // paused in the film itself (a tap on it): the reader is looking
    S.paused = true; S.stayed = true; clearTimeout(S.advance); setBody();
  }
  if (s === 0 && !S.ended) end(f.item);   // the episode itself ended (a moment at its very end)
}

function playError(f, code) {
  f.errored = code;
  // an error in the player itself (5) is worth one fresh load before the reel gives up on the film
  if (code === 5 && f.item === S.cur && !f.retried) {
    const x = S.items[f.item];
    f.retried = true;
    f.target = x.clip[0];
    f.yt.loadVideoById({ videoId: x.v, startSeconds: x.clip[0] / 100 });
    return;
  }
  if (f.item === S.cur) unplayable(f.item, code === 101 || code === 150 || code === 153 ? "YouTube won’t play this film outside YouTube."
    : code === 100 ? "This film isn’t on YouTube any more." : "YouTube couldn’t play this film.");
}

function unplayable(i, why) {
  const slot = slotOf(i), x = S.items[i];
  if (!slot || !x) return;
  slot.dataset.state = "error";
  // said under the film, never over it: the player shows YouTube's own message in its place
  const foot = slot.querySelector(".foot");
  foot.querySelector(".t").textContent = why;
  // its words are still here to read; the reel moves on once they have been read
  S.ended = true; S.broken = true; setBody();
  if (S.playOn && !S.stayed && S.unattended < 10) S.advance = setTimeout(() => { if (S.cur === i) { S.unattended++; step(1); } }, readMs(x, 0) + 1500);
}

/* Where the film is, in centiseconds: YouTube's last report, carried forward by the clock between
   reports. Straight after a seek it still reports the old time for a few frames; until it reaches
   the target, the target is the truth. */
function now(f) {
  const v = f.yt.getCurrentTime() * 100, w = performance.now();
  if (f.target != null) {
    if (Math.abs(v - f.target) < 200) f.target = null;
    else return f.target;
  }
  if (v !== f.lastV) { f.lastV = v; f.lastW = w; }
  if (f.state !== 1) return v;
  return f.lastV + Math.min(400, w - f.lastW) / 10 * (f.yt.getPlaybackRate?.() || 1);
}

function watch(i) {
  cancelAnimationFrame(S.raf); clearInterval(S.watch);
  const x = S.items[i], f = frameOf(i), slot = slotOf(i);
  const words = [...slot.querySelectorAll(".said .w")], foot = slot.querySelector(".foot");
  const [a, b] = x.clip;
  let lit = -1, rec = S.timing[S.timing.length - 1];
  const tick = () => {
    if (S.cur !== i || !f.yt?.getCurrentTime) return;
    const t = now(f);
    if (rec && rec.moved == null && f.state === 1 && f.target == null && t > a + 5) {
      rec.moved = Math.round(performance.now() - rec.t0);
      slot.dataset.moved = String(rec.moved + rec.lead);
    }
    if (!S.free) foot.style.setProperty("--p", Math.max(0, Math.min(1, (t - a) / (b - a))).toFixed(4));
    // the words said so far in ink, the one being said in the speaker's colour
    let k = lit;
    while (k + 1 < words.length && a + x.words[k + 1][0] <= t) k++;
    while (k >= 0 && a + x.words[k][0] > t) k--;
    if (k !== lit) {
      words.forEach((w, j) => { w.classList.toggle("on", j < k); w.classList.toggle("now", j === k); });
      lit = k;
    }
    if (!S.free && !S.ended && f.state === 1 && f.target == null && t >= b - 12) end(i);
  };
  const frame = () => { S.raf = requestAnimationFrame(frame); tick(); };
  frame();
  S.watch = setInterval(tick, 50);   // a background tab gets no frames: the clip must still end
}

/* The clip's end: a short fade on the last word's tail, then stop, then (unless the reader is
   looking) on to the next once there has been time to read this one. */
async function end(i) {
  const f = frameOf(i), x = S.items[i], slot = slotOf(i);
  S.ended = true;
  S.pausing = true;
  if (!f.yt.isMuted()) for (const v of [60, 30, 10]) { f.yt.setVolume(v); await sleep(30); }
  f.yt.pauseVideo();
  setTimeout(() => { f.yt.setVolume(100); S.pausing = false; }, 250);
  const rec = S.timing.find((r) => r.id === x.id && r.stopped == null);
  if (rec) setTimeout(() => { rec.stopped = Math.round(f.yt.getCurrentTime() * 100); slot.dataset.stopped = String(rec.stopped); }, 300);
  if (S.cur !== i) return;
  slot.dataset.state = "ended";
  slot.querySelector(".foot").style.setProperty("--p", "1");
  setBody();
  // on by itself for ten moments at most: after that it waits for the reader (no film plays on and on
  // to an empty room)
  if (S.playOn && !S.stayed && S.unattended < 10 && i + 1 < count())
    S.advance = setTimeout(() => { if (S.cur === i && S.ended && !S.stayed) { S.unattended++; step(1); } }, readMs(x, x.clip[1] - x.clip[0]));
}

/* Time to read a reel, less the time its film already gave: about four words a second. */
function readMs(x, playedCs) {
  const wide = matchMedia("(min-width: 980px) and (min-height: 560px)").matches;
  const shown = wide ? ({ S: x.more?.[1], C: x.more?.[0], R: x.more?.[0] }[x.k] || x.dek) : x.dek;
  const words = `${x.head} ${shown || ""}`.split(/\s+/).length;
  return Math.max(1400, words * 250 - playedCs * 10 * 0.6);
}

function pause() {
  // the reader's wish first, whether or not the player is ready to hear it (play() checks it)
  S.paused = true; S.stayed = true; clearTimeout(S.advance); setBody();
  const f = frameOf(S.cur);
  if (!f?.yt?.pauseVideo) return;
  S.pausing = true;
  f.yt.pauseVideo();
  setTimeout(() => { S.pausing = false; }, 250);
}
function resume() {
  const f = frameOf(S.cur), x = S.items[S.cur];
  if (!x) return;
  if (S.ended && !S.free) return again();
  S.paused = false; setBody();
  if (!f?.yt?.playVideo || f.video !== x.v) return play(S.cur);   // paused before it ever loaded
  if (S.sound) f.yt.unMute();
  f.yt.playVideo();
}
function again() {
  S.stayed = true;
  const x = S.items[S.cur], f = frameOf(S.cur);
  if (!x || !f) return;
  if (!f.yt?.seekTo || f.video !== x.v) return play(S.cur);
  Object.assign(S, { ended: false, paused: false, free: false });
  setBody();
  slotOf(S.cur).dataset.state = "playing";
  f.target = x.clip[0];
  if (S.sound) f.yt.unMute();
  f.yt.seekTo(x.clip[0] / 100, true);
  f.yt.playVideo();
  watch(S.cur);
}
/* Keep listening: the episode plays on from the clip, as long as the reader wants. */
function listenOn() {
  const f = frameOf(S.cur), slot = slotOf(S.cur);
  if (!f?.yt) return;
  S.stayed = true; S.free = true; S.ended = false; S.paused = false;
  clearTimeout(S.advance);
  slot.dataset.state = "free";
  slot.querySelector(".foot").style.setProperty("--p", "0");
  setBody();
  if (S.sound) f.yt.unMute();
  f.yt.playVideo();
}

/* ── moving through the reel ─────────────────────────────────────────────── */

function scrollToI(i, smooth = true) {
  // A snap point is a slot, and slots stand only around the reel on screen: a jump further than that
  // (to the top, to the end) lays them out where it lands first, or the snap would pull it back.
  if (Math.abs(i - S.cur) > 2) { layout(i); smooth = false; }
  feed.scrollTo({ top: i * S.H, behavior: smooth && !reduced.matches ? "smooth" : "instant" });
}
function step(d, focus = false) {
  const i = Math.max(0, Math.min(count() - 1, S.cur + d));
  if (i === S.cur) return;
  S.gestureAt = performance.now();
  S.focusOn = focus ? i : null;
  scrollToI(i);
}

/* The reel on screen changed: stop the last, start this one, keep the players and pages ahead. */
function go(i) {
  if (i === S.cur || i < 0) return;
  const was = S.cur;
  S.cur = i;
  clearTimeout(S.advance); clearInterval(S.stall);
  cancelAnimationFrame(S.raf); clearInterval(S.watch);
  S.stayed = false;
  S.pausing = true;
  for (const f of S.frames) if (f.yt?.pauseVideo && (f.state === 1 || f.state === 3)) f.yt.pauseVideo();
  setTimeout(() => { S.pausing = false; }, 250);
  layout();
  assign();
  const x = S.items[i];
  if (x) {
    history.replaceState(null, "", urlFor(x));
    if (!Object.keys(S.filters).length && !(S.lead && i === 0)) store.set("eie.reel.pos", S.base + i);
    $("#where").textContent = S.lead && i === 0 ? "a shared moment" : `${fmt(S.base + i + 1)} of ${fmt(S.total)}`;
    $("#status").textContent = `${kindOf(x)}${WHO[x.spk] ? `, ${WHO[x.spk]}` : ""}: ${x.head}. Episode ${x.ep}, at ${clock(x.clip[0])}.`;
    play(i);
  } else {
    S.ended = true; setBody();
    $("#where").textContent = S.total ? `${fmt(S.total)} of ${fmt(S.total)}` : "";
  }
  if (S.focusOn === i) { S.focusOn = null; slotOf(i)?.focus({ preventScroll: true }); }
  $("#prev").disabled = i === 0;
  $("#next").disabled = i >= count() - 1;
  if (S.next != null && i >= S.items.length - 4) load(true).then(more);
}

/* A page arrived (or didn't): lay it out; the switch turned off ends the reel at once; and a moment that
   took the place of "the reel stopped loading" under the reader is started properly. */
function more() {
  if (S.off) return resting();
  const i = S.cur, was = slotOf(i)?.classList.contains("end");
  layout(); assign();
  if (was && i < S.items.length) { S.cur = -1; go(i); }
  $("#next").disabled = S.cur >= count() - 1;
}

function setBody() {
  const b = document.body;
  b.toggleAttribute("data-ended", S.ended && !S.free);
  b.toggleAttribute("data-paused", S.paused);
  const play = $("#play");
  play.setAttribute("aria-label", S.ended && !S.free ? "Play it again" : S.paused ? "Play" : "Pause");
  $("#more").hidden = !(S.ended && !S.free && !S.broken && S.items[S.cur]);
  document.body.toggleAttribute("data-broken", !!S.broken);
  $("#share").hidden = !$("#more").hidden && innerWidth < 420;
}
/* What the sound button says is what the reader hears: on only when it is the reader's choice and the
   browser lets it play. Off while a film plays is the one thing to fix first, so it is the dark button. */
function setSound() {
  const b = $("#sound"), audible = S.sound && !S.blocked;
  b.setAttribute("aria-pressed", String(audible));
  b.setAttribute("aria-label", audible ? "Sound on. Turn it off" : "Sound off. Turn it on");
  b.querySelector(".label").textContent = audible ? "Sound on" : S.blocked ? "Tap for sound" : "Sound off";
  document.body.toggleAttribute("data-muted-playing", !audible && frameOf(S.cur)?.state === 1);
}

/* The current reel: the slot most of the screen shows, once the finger has let go. */
let settle = 0;
function onScroll() {
  clearTimeout(settle);
  if (!S.items.length) return;
  const i = Math.round(feed.scrollTop / Math.max(1, S.H));
  const exact = Math.abs(feed.scrollTop - i * S.H) < 2;
  if (exact && !S.touching) return go(i);
  settle = setTimeout(() => { if (!S.touching) go(Math.round(feed.scrollTop / Math.max(1, S.H))); }, 120);
}

/* ── the sheet: narrowing the reel; a piece in full ───────────────────────── */

let menu = null, opener = null;
function openSheet(card, from) {
  opener = from || document.activeElement;
  $("#sheet-card").replaceChildren(...card.filter(Boolean));   // (replaceChildren writes a null as the word "null")
  $("#sheet").hidden = false;
  for (const el of [feed, $("#bar"), $("#ctl")]) el.inert = true;
  $("#sheet-card").focus({ preventScroll: true });
  if (!S.paused && !S.ended) { pause(); S.resumeAfterSheet = true; }
}
function closeSheet() {
  if ($("#sheet").hidden) return;
  $("#sheet").hidden = true;
  for (const el of [feed, $("#bar"), $("#ctl")]) el.inert = false;
  opener?.focus?.();
  if (S.resumeAfterSheet) { S.resumeAfterSheet = false; resume(); }
}

async function chooser() {
  menu ||= fetch(`${API}/menu`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const m = await menu;
  const f = S.filters, x = S.items[S.cur];
  const pick = (patch) => { const nf = { ...S.filters, ...patch }; for (const k of Object.keys(nf)) if (!nf[k]) delete nf[k]; restart(nf); };
  const chip = (label, on, patch, n) => h("button", { type: "button", "aria-pressed": String(!!on), onclick: () => pick(patch) }, label, n != null ? h("span", { class: "n t" }, fmt(n)) : null);
  const kinds = [["", "Everything"], ["S", "Stories"], ["C", "Ideas"], ["R", "Books & more"], ["J", "Laughs"]];
  const q = h("input", { type: "search", name: "q", placeholder: "Taxes, tomatoes, Hayek…", value: f.q || "", autocomplete: "off", "aria-label": "Find moments about" });
  const card = [
    h("h2", { id: "sheet-h" }, "Watch"),
    h("p", { class: "sub" }, "The whole newsreel, or a part of it."),
    h("form", { class: "find", onsubmit: (e) => { e.preventDefault(); pick({ q: q.value.trim(), idea: "", ep: "" }); } }, q, h("button", { type: "submit" }, "Find")),
    h("h3", {}, "Which"),
    h("div", { class: "chips" },
      chip("The newsreel", !f.ep && !f.idea && !f.q, { ep: "", idea: "", q: "" }),
      x ? chip(`This episode, No. ${x.ep}`, f.ep == x.ep, { ep: String(x.ep), idea: "", q: "" }) : null),
    h("h3", {}, "What"),
    h("div", { class: "chips" }, kinds.map(([k, label]) => chip(label, (f.kind || "") === k, { kind: k }))),
    h("h3", {}, "Who"),
    h("div", { class: "chips" }, chip("Both", !f.who, { who: "" }), chip("Amit Varma", f.who === "amit", { who: "amit" }), chip("Ajay Shah", f.who === "ajay", { who: "ajay" })),
    m ? h("h3", {}, "The big ideas, as the show built them") : null,
    m ? h("div", { class: "chips" }, m.ideas.map((d) => chip(d.name, f.idea === d.id, { idea: d.id, ep: "", q: "" }, d.n))) : null,
    h("h3", {}, "After each moment"),
    h("div", { class: "chips" },
      h("button", { type: "button", "aria-pressed": String(S.playOn), onclick: (e) => { S.playOn = true; store.set("eie.reel.on", true); e.currentTarget.setAttribute("aria-pressed", "true"); e.currentTarget.nextSibling.setAttribute("aria-pressed", "false"); } }, "Go on to the next"),
      h("button", { type: "button", "aria-pressed": String(!S.playOn), onclick: (e) => { S.playOn = false; store.set("eie.reel.on", false); e.currentTarget.setAttribute("aria-pressed", "true"); e.currentTarget.previousSibling.setAttribute("aria-pressed", "false"); } }, "Stay on it")),
    h("button", { type: "button", class: "done", onclick: closeSheet }, "Done"),
    terms(),
  ];
  openSheet(card, $("#which"));
}

function whole(i) {
  const x = S.items[i];
  if (!x) return;
  const paper = `${SITE}${x.ep}/${x.paper ? `#${x.paper}` : ""}`;
  openSheet([
    h("p", { class: "kicker", style: { "--c": INK[x.spk] } }, h("span", { class: "dot", "aria-hidden": "true" }), kindOf(x), WHO[x.spk] ? h("span", { class: "who" }, `· ${WHO[x.spk]}`) : null),
    h("h2", { id: "sheet-h", class: "piece" }, x.head || "A laugh"),
    x.by ? h("p", { class: "sub" }, x.by) : null,
    h("div", { class: "whole" }, (x.more || []).filter(Boolean).map((p) => h("p", {}, p))),
    h("div", { class: "chips" },
      h("a", { href: paper }, x.printed ? `In the paper: “${x.printed}”` : `In the paper, No. ${x.ep}`),
      h("a", { href: youtube(x), target: "_blank", rel: "noopener" }, `On YouTube at ${clock(x.clip[0])} ↗`)),
    h("button", { type: "button", class: "done", onclick: closeSheet }, "Done"),
  ], document.activeElement);
}

/* A new reel (a filter chosen): the same page, from its first moment. */
async function restart(filters) {
  S.resumeAfterSheet = false;
  closeSheet();
  S.gen++;
  S.loading = null;
  cancelAnimationFrame(S.raf); clearInterval(S.watch); clearTimeout(S.advance); clearInterval(S.stall);
  S.filters = filters; S.from = null; S.startAt = 0;
  for (const f of S.frames) { if (f.yt?.pauseVideo) f.yt.pauseVideo(); f.item = -1; }
  list.replaceChildren(...S.slots);   // put the slots back where an empty or resting state stood
  Object.assign(S, { items: [], next: 0, cur: -1, base: 0, total: 0, lead: false, failed: false, off: false, unattended: 0,
    ended: false, paused: false, free: false, broken: false });
  history.replaceState(null, "", urlFor(null));
  for (const s of S.slots) { s.dataset.i = "-1"; s.replaceChildren(); }
  feed.scrollTop = 0;
  await start();
}

/* The films are YouTube's: where they come from, on whose terms. */
function terms() {
  return h("p", { class: "terms" }, "The films play from YouTube, under ",
    h("a", { href: "https://www.youtube.com/t/terms", target: "_blank", rel: "noopener" }, "YouTube’s Terms of Service"), " and ",
    h("a", { href: "https://policies.google.com/privacy", target: "_blank", rel: "noopener" }, "Google’s Privacy Policy"),
    ". The words, headlines and notes are the archive’s, made from each episode’s transcript.");
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.setAttribute("data-on", "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.removeAttribute("data-on"), 2600);
}

async function share() {
  const x = S.items[S.cur];
  if (!x) return;
  const url = `${PUBLIC}?n=${x.id}`;
  const text = `${WHO[x.spk] ? `${WHO[x.spk]}: ` : ""}${x.head}`;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: x.head, text, url }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast(url); }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

function wire() {
  // anything the reader does means someone is there
  for (const t of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(t, () => { S.unattended = 0; }, { passive: true, capture: true });
  feed.addEventListener("scroll", onScroll, { passive: true });
  feed.addEventListener("touchstart", () => { S.touching = true; S.stayed = S.stayed || S.ended; }, { passive: true });
  feed.addEventListener("touchend", () => { S.touching = false; S.gestureAt = performance.now(); onScroll(); }, { passive: true });
  feed.addEventListener("touchcancel", () => { S.touching = false; onScroll(); }, { passive: true });
  // a reader reading (a pointer over the words, a selection) keeps the reel where it is
  feed.addEventListener("pointerdown", (e) => { if (e.target.closest(".text, .said")) S.stayed = true; });
  feed.addEventListener("click", (e) => {
    const dek = e.target.closest(".dek, .head");
    const slot = e.target.closest(".reel");
    if (dek && slot && !e.target.closest("a")) whole(+slot.dataset.i);
  });
  new ResizeObserver(() => { const i = S.cur; layout(); if (i >= 0) feed.scrollTop = i * S.H; }).observe(feed);
  $("#play").addEventListener("click", () => (S.ended && !S.free ? again() : S.paused ? resume() : pause()));
  $("#more").addEventListener("click", listenOn);
  $("#next").addEventListener("click", () => step(1));
  $("#prev").addEventListener("click", () => step(-1));
  $("#share").addEventListener("click", share);
  $("#which").addEventListener("click", chooser);
  $("#sound").addEventListener("click", () => {
    // in this tap (the browser counts it as the reader's say-so): sound on, or off
    S.sound = !(S.sound && !S.blocked);
    S.blocked = false;
    store.set("eie.reel.sound", S.sound);
    for (const f of S.frames) if (f.yt?.mute) (S.sound && f.item === S.cur ? (f.yt.unMute(), f.yt.setVolume(100)) : f.yt.mute());
    const f = frameOf(S.cur);
    if (S.sound && f?.yt && f.state !== 1 && !S.ended && !S.paused) f.yt.playVideo();
    setSound();
    // A browser that lets only a tap on the film itself give it sound (Safari on a phone may) stops
    // it instead, or keeps it silent: say where to tap.
    if (S.sound && f?.yt) setTimeout(() => {
      if (S.cur === f.item && !S.ended && (f.state !== 1 || f.yt.isMuted())) toast("Tap the film itself to hear it");
    }, 1200);
  });
  $("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("#sheet").hidden) { if (e.key === "Escape") closeSheet(); return; }
    const k = e.key;
    if (k === "ArrowDown" || k === "j" || k === "PageDown") { e.preventDefault(); step(1, true); }
    else if (k === "ArrowUp" || k === "k" || k === "PageUp") { e.preventDefault(); step(-1, true); }
    else if (k === "Home") { e.preventDefault(); scrollToI(0); }
    else if (k === " " && !e.target.closest("button, a")) { e.preventDefault(); $("#play").click(); }
    else if (k === "m") $("#sound").click();
    else if (k === "l" && S.ended) listenOn();
  });
  let hidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (!S.paused && !S.ended) { hidden = true; pause(); S.stayed = false; } }
    else if (hidden) { hidden = false; resume(); }
  });
  addEventListener("pageshow", (e) => { if (e.persisted) { layout(); placeFrames(); } });
  addEventListener("online", () => { if (S.failed) { S.failed = false; load(true).then(more); } });
}

async function start() {
  await load();
  if (S.off) return resting();
  $("#name").textContent = S.name || "The newsreel";
  if (!S.items.length) return nothing();
  document.title = `${S.name} · Everything is Everything`;
  layout();
  if (!S.frames.length) for (let k = 0; k < FRAMES; k++) S.frames.push(makeFrame(k));
  feed.scrollTop = 0;
  go(0);
  document.body.classList.add("ready");
}

function message(...kids) {
  // shown in the list in place of the slots (kept aside, and put back by restart())
  for (const f of S.frames) if (f.yt?.pauseVideo) f.yt.pauseVideo();
  cancelAnimationFrame(S.raf); clearInterval(S.watch); clearTimeout(S.advance); clearInterval(S.stall);
  list.replaceChildren(h("article", { class: "reel end", style: { top: "0", height: "100%" } }, h("div", { class: "inner" }, ...kids)));
  track.style.height = "100%";
  for (const f of S.frames) f.el.style.width = f.el.style.height = "0px";
  document.body.classList.add("ready");
}

function resting() {
  document.body.classList.add("resting");
  message(
    h("h2", {}, "The newsreel is resting"),
    h("p", {}, "It will be back. The paper, with every moment in it, is where it always is."),
    h("div", { class: "ways" }, h("a", { class: "first", href: SITE }, "The paper")));
  $("#ctl").hidden = true; $("#which").disabled = true;
  $("#where").textContent = "";
}
function nothing() {
  $("#where").textContent = "";
  message(
    h("h2", {}, S.failed ? "The newsreel didn’t load" : "Nothing here"),
    h("p", {}, S.failed ? "The connection may have dropped." : S.filters.q ? `No moment matches “${S.filters.q}”. Try fewer or other words.` : "No moment matches this."),
    h("div", { class: "ways" },
      S.failed ? h("button", { type: "button", class: "first", onclick: () => location.reload() }, "Try again")
        : h("button", { type: "button", class: "first", onclick: chooser }, "Choose again"),
      h("a", { href: location.pathname + "?" }, "The whole newsreel"),
      h("a", { href: SITE }, "The paper")));
}

readUrl();
setSound();
makeSlots();
wire();
api().catch(() => {});   // the player's script, while the first page loads
start();
