/* The archive desk: “Lost & Found”. Half-remember something from the show, describe it however vaguely,
   and the desk finds where it was printed, then takes you there and rings it in red pencil.

   On the archive's front page it is a box under the nameplate (an element with id "desk"); in an edition
   it is a drawer, opened from the edition bar or with "/". The search itself is eie.taptappers.club's
   /api/search (site/search/server.py): the reader's words find candidates among every place in every
   edition, and Claude picks the ones meant. */
(() => {
  const ED = +(document.body.dataset.ep || 0);              // in an edition, its number; 0 on the front page
  const ROOT = ED ? "../" : "./";
  const HOME = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) || location.hostname === "eie.taptappers.club";
  const API = HOME ? "/api/search" : "https://eie.taptappers.club/api/search";
  const ASKED = API.replace(/search$/, "asked");
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  const KIND = { lead: "The lead", story: "A story", opinion: "Opinion", brief: "In brief", thought: "Thought for the day", box: "Box",
    number: "By the numbers", shelf: "On the shelf", laugh: "Laugh lines", word: "Word watch" };
  // things readers half-remember, each of which the desk finds: three at a time, as a hint of what to type
  // (each checked to land on the place it describes, best first)
  const TRY = ["the guy who did push-ups as penance", "why cartels always fall apart", "chess, sugar and brain fog",
    "the witch doctor and the Nile", "Springsteen's advice on writing hits", "the book about cooperation in war",
    "when Amit reversed his diabetes", "markets know what no planner knows", "the cricketer who blocked all day for a draw",
    "Ajay's parents eloped", "a monkey throwing darts beats fund managers"];

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(tag === "svg" || tag === "path" || tag === "filter" || tag.startsWith("fe") ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k);
    return el;
  }
  const GLASS = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12.6 12.6 17 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  /* ── the box: a classified ad, the same on the front page and in the drawer ─────────────────── */
  function box(mode) {
    const id = `desk-${mode}`;
    const input = h("input", { type: "search", id: `${id}-q`, name: "q", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
      // a placeholder whole at the narrowest width: on a phone the long one was cut mid-phrase
      maxlength: "300", placeholder: innerWidth < 560 ? "push-ups as penance…" : "the story about push-ups as penance…", "aria-describedby": `${id}-how` });
    const go = h("button", { type: "submit", class: "desk-go" }, "Find it");
    const form = h("form", { class: "desk-form", role: "search", "aria-label": "Search the archive" },
      h("label", { class: "desk-lost", for: input.id }, "Lost", h("span", { class: "sr-only" }, ": describe what you remember")), input, go);
    const picks = [...TRY].sort(() => Math.random() - 0.5).slice(0, 3);
    const tries = h("p", { class: "desk-try" }, h("span", {}, "Try"), picks.map((t) => h("button", { type: "button", class: "desk-eg" }, t)));
    const out = h("div", { class: "desk-out", "aria-live": "polite" });
    const asked = h("div", { class: "desk-asked", hidden: true });
    const el = h("section", { class: `desk desk-${mode}`, "aria-labelledby": `${id}-h` },
      h("div", { class: "desk-top" }, h("h2", { class: "desk-h", id: `${id}-h` }, "Lost & Found"),
        h("span", { class: "desk-tag" }, "The archive desk")),
      h("p", { class: "desk-how", id: `${id}-how` }, "Lost something from the show? A story, an argument, a book, a joke: describe it the way you remember it, however vaguely, and the desk will find the page it was printed on."),
      form, tries, asked, out);
    form.addEventListener("submit", (ev) => { ev.preventDefault(); ask(input.value, out, input); });
    tries.addEventListener("click", (ev) => {
      const b = ev.target.closest(".desk-eg");
      if (b) { input.value = b.textContent; ask(b.textContent, out, input); }
    });
    asked.addEventListener("click", (ev) => {
      const b = ev.target.closest(".desk-q");
      if (b) { input.value = b.dataset.q; ask(b.dataset.q, out, input); }
    });
    // cleared, the box is as it was: what readers asked comes back
    input.addEventListener("input", () => { if (!input.value) { el.classList.remove("asked"); out.replaceChildren(); last = null; } });
    lately().then((d) => float(d, asked, tries)).catch(() => {});
    return { el, input, out };
  }

  /* ── what readers asked, floated along the bar: the questions the desk judged fit to show others
     (see search/server.py), most recent first. Until there are any, the "Try" examples stand in. ── */
  let latelyP = null;
  const lately = () => (latelyP ||= fetch(ASKED).then((r) => (r.ok ? r.json() : null)));

  function float(d, asked, tries) {
    if (!d?.asked?.length) return;
    const qs = d.asked.slice(0, 24);
    const item = (x) => [h("button", { type: "button", class: "desk-q", "data-q": x.q, title: x.n > 1 ? `Asked ${x.n} times` : null }, x.q),
      h("span", { class: "desk-sep", "aria-hidden": "true" })];
    const track = h("div", { class: "desk-track" }, h("span", { class: "desk-run" }, qs.map((x) => item(x))));
    const tape = h("div", { class: "desk-tape", role: "group", "aria-label": "Questions other readers asked lately" }, track);
    const total = d.total.toLocaleString("en-IN");
    asked.replaceChildren(h("span", { class: "desk-asked-k" }, "Readers asked"), tape,
      h("p", { class: "desk-asked-note" }, `${total} ${d.total === 1 ? "question" : "questions"} asked so far. Questions are shown to other readers, without names.`));
    asked.hidden = false;
    tries.hidden = true;
    // only what is wider than the bar drifts, and slowly: a second copy makes the loop seamless
    requestAnimationFrame(() => {
      const run = track.firstElementChild, w = run.getBoundingClientRect().width;
      if (w <= tape.clientWidth || RM.matches) return;
      const copy = run.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      for (const b of copy.querySelectorAll("button")) b.tabIndex = -1;
      track.append(copy);
      track.style.setProperty("--drift", `${Math.round(w / 34)}s`);   // about 34 px a second
      tape.classList.add("drifting");
    });
  }

  /* ── asking ─────────────────────────────────────────────────────────────────────────────────── */
  let ctl = null, last = null;
  async function ask(q, out, input) {
    q = (q || "").trim();
    if (q.length < 2) { input.focus(); return; }
    if (last && last.q === q && last.best && out.querySelector(".clip.best")) { go(last.best, q); return; }   // Enter twice: go
    ctl?.abort();
    const mine = (ctl = new AbortController());
    let late = false;
    const timer = setTimeout(() => { late = true; mine.abort(); }, 25000);
    const wait = reading();
    out.replaceChildren(wait.el);
    out.closest(".desk")?.classList.add("asked");
    try {
      const r = await fetch(`${API}?q=${encodeURIComponent(q)}`, { signal: mine.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (mine !== ctl) return;
      last = { q, best: d.results?.[0] || null };
      out.replaceChildren(...found(d, q).filter(Boolean));
    } catch (e) {
      if (e.name === "AbortError" && !late) return;
      out.replaceChildren(h("p", { class: "desk-say" }, late ? "The desk took too long to answer. Try again in a moment." : "The desk is closed for a moment. Try again shortly."));
    } finally {
      clearTimeout(timer);
      wait.stop();
    }
  }

  /* while the desk reads: the edition it has reached, flipping past, the one thing that moves */
  function reading() {
    const no = h("b", { class: "t" }, "1");
    const el = h("p", { class: "desk-reading" }, RM.matches ? "The desk is reading through all 128 editions…" : ["The desk is reading through the editions… No. ", no]);
    let n = 1;
    const tick = RM.matches ? null : setInterval(() => { n = (n % 128) + 1; no.textContent = n; }, 45);
    return { el, stop: () => clearInterval(tick) };
  }

  function found(d, q) {
    const R = d.results || [];
    if (!R.length) return [h("p", { class: "desk-say" }, "Nothing in the archive answers to that. Try other words: a person, a place, a number you remember.")];
    const count = h("p", { class: "desk-count" }, R.length === 1 ? "The desk found it" : `The desk found ${R.length} places`,
      d.mode === "words" ? h("span", { class: "desk-quick" }, "matched by words alone: the desk’s reader is busy") : null);
    const [best, ...rest] = R;
    return [count, clip(best, q, true), rest.length ? h("div", { class: "desk-more" }, rest.map((r) => clip(r, q, false))) : null];
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  function clip(r, q, best) {
    const [y, m, d] = r.date.split("-").map(Number);
    const head = r.head;   // a laugh line has none: its words are quoted instead
    const a = h("a", { class: `clip${best ? " best" : ""}`, href: `${ROOT}${r.url}` }, h("span", { class: "clip-paper" },
      // the dateline breaks between its parts, never inside one
      h("span", { class: "clip-line" }, h("span", {}, `Episode ${r.ep}`), h("span", {}, `${d} ${MONTHS[m - 1]} ${y}`), h("b", {}, `Page ${r.page}`),
        best && KIND[r.kind] ? h("span", {}, KIND[r.kind]) : null),
      head ? h("span", { class: "clip-head" }, head) : h("q", { class: "clip-quote" }, r.snip),
      best && r.kicker ? h("span", { class: "clip-kick" }, r.kicker) : null,
      best && r.head ? h("span", { class: "clip-snip" }, r.snip) : null,
      r.note && (head || !r.snip.startsWith(r.note.slice(0, 24))) ? h("span", { class: "clip-note" }, r.note) : null,
      best ? h("span", { class: "clip-go" }, ED === r.ep ? "It’s in this edition →" : `Turn to page ${r.page} of Episode ${r.ep} →`) : null));
    a.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button) return;   // a new tab goes plainly
      ev.preventDefault();
      go(r, q);
    });
    return a;
  }

  function go(r, q) {
    if (ED && r.ep === ED) {
      close();
      history.replaceState(null, "", `#${r.a}`);
      mark(r.a, q);
      return;
    }
    try { sessionStorage.setItem("eie.found", JSON.stringify({ ep: r.ep, a: r.a, q, t: Date.now() })); } catch {}
    location.href = `${ROOT}${r.url}`;
  }

  /* ── arriving: the place found, ringed in red pencil, with a note in the margin ──────────────── */
  function target(el) {
    // ring what a reader looks for: a story's headline, an entry's title, a short thing whole
    if (el.matches(".mod")) return el.querySelector("h2, h3") || el;
    if (el.matches("h3") && el.nextElementSibling?.matches("p")) return [el, el.nextElementSibling];
    return el;
  }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function inked(e) {   // the box of an element's words (a headline's block is the column's width)
    if (!/^(H[1-6]|P|B|SPAN|LI)$/.test(e.tagName)) return e.getBoundingClientRect();
    const r = document.createRange();
    r.selectNodeContents(e);
    const b = r.getBoundingClientRect();
    return b.width ? b : e.getBoundingClientRect();
  }
  function box2(els) {
    const rs = [].concat(els).filter(visible).map(inked);
    if (!rs.length) return null;
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top)), R = Math.max(...rs.map((r) => r.right)), B = Math.max(...rs.map((r) => r.bottom));
    return { left: l + scrollX, top: t + scrollY, width: R - l, height: B - t };
  }

  // a loop drawn by hand: a squarish oval (a superellipse hugs a line of type better than an ellipse),
  // begun just before the top, carried round a little past its start, the hand easing out as it closes
  function loop(w, ht) {
    let seed = Math.round(w * 7 + ht * 13) % 233280 || 1;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const p = 3.2, cx = w / 2, cy = ht / 2, n = 64, a0 = -Math.PI * 0.58, sweep = Math.PI * 2.16;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = a0 + sweep * t, c = Math.cos(a), s = Math.sin(a);
      const k = 1 + (rnd() - 0.5) * 0.022 + 0.035 * t;     // a hand is not a compass
      // 0.95: the hand's overshoot stays inside the box, which stays inside the window
      pts.push([cx + Math.sign(c) * Math.abs(c) ** (2 / p) * cx * k * 0.95, cy + Math.sign(s) * Math.abs(s) ** (2 / p) * cy * k * 0.95 * (1 + 0.05 * t)]);
    }
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  let ringEl = null, noteEl = null;
  function unmark() { ringEl?.remove(); noteEl?.remove(); ringEl = noteEl = null; }

  function mark(anchor, q) {
    unmark();
    let el = document.getElementById(anchor);
    if (!el) return;
    let what = target(el);
    if (![].concat(what).some(visible)) {   // a line the page left out to fit (a laugh past the fourth): its module, then
      const mod = el.closest(".mod");
      what = mod ? target(mod) : el;
    }
    const first = [].concat(what).find(visible) || el;
    first.scrollIntoView({ block: "center", behavior: RM.matches ? "auto" : "smooth" });
    const draw = () => {
      const b = box2(what);
      if (!b) return;
      const padX = Math.min(26, 10 + b.width * 0.035), padY = Math.min(13, 6 + b.height * 0.1);   // close, but clear of the words
      // never wider than the window: on a phone a headline spans it, and a ring past its edge would let
      // the page scroll sideways
      const x0 = Math.max(scrollX + 3, b.left - padX), x1 = Math.min(scrollX + document.documentElement.clientWidth - 3, b.left + b.width + padX);
      const w = x1 - x0, ht = b.height + padY * 2;
      const path = h("path", { d: loop(w, ht), pathLength: "1", class: "ring-line" });
      ringEl = h("svg", { class: "desk-ring", width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true",
        style: `left:${x0}px;top:${b.top - padY}px` },
      h("filter", { id: "pencil" }, h("feTurbulence", { type: "fractalNoise", baseFrequency: "1.6", numOctaves: "2", result: "grain" }),
        h("feDisplacementMap", { in: "SourceGraphic", in2: "grain", scale: "1.6" })), path);
      document.body.append(ringEl);
      noteEl = h("p", { class: "desk-mark", role: "status" },
        h("span", {}, "Found"), h("i", {}, `“${q}”`),
        h("button", { type: "button", class: "desk-x", "aria-label": "Rub out the ring" }, "×"));
      noteEl.querySelector("button").addEventListener("click", unmark);
      document.body.append(noteEl);
      if (!RM.matches) requestAnimationFrame(() => ringEl?.classList.add("drawn"));
      else ringEl.classList.add("drawn", "still");
    };
    // draw once the scroll has come to rest, so the ring is measured where the page will stay
    let last = -1, still = 0;
    const settle = () => {
      if (Math.abs(scrollY - last) < 1) still++; else still = 0;
      last = scrollY;
      if (still >= 4) draw(); else requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }
  addEventListener("resize", () => { if (ringEl) { const a = decodeURIComponent(location.hash.slice(1)); const q = noteEl?.querySelector("i")?.textContent.slice(1, -1); unmark(); if (a && q) mark(a, q); } });

  /* ── the drawer, in an edition ─────────────────────────────────────────────────────────────── */
  let drawer = null, back = null, opener = null;
  function open(from) {
    opener = from || document.activeElement;
    if (!drawer) {
      const b = box("drawer");
      const x = h("button", { type: "button", class: "desk-close", "aria-label": "Close the desk" }, "×");
      x.addEventListener("click", close);
      drawer = h("div", { class: "desk-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "desk-drawer-h" }, x, b.el);
      back = h("div", { class: "desk-back", "aria-hidden": "true" });
      back.addEventListener("click", close);
      drawer.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
        if (ev.key === "Tab") {   // the drawer keeps the focus while it is open
          const f = [...drawer.querySelectorAll("button, input, a[href]")].filter(visible);
          if (!f.length) return;
          if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f.at(-1).focus(); }
          else if (!ev.shiftKey && document.activeElement === f.at(-1)) { ev.preventDefault(); f[0].focus(); }
        }
      });
      document.body.append(back, drawer);
    }
    document.documentElement.classList.add("desk-open");
    drawer.hidden = back.hidden = false;
    requestAnimationFrame(() => drawer.querySelector("input").focus());
  }
  function close() {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = back.hidden = true;
    document.documentElement.classList.remove("desk-open");
    opener?.focus?.({ preventScroll: true });
  }

  function typing(t) { return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) || t.closest?.(".cw-grid")); }

  function start() {
    const home = document.getElementById("desk");
    if (home) home.replaceWith(box("inline").el);
    document.addEventListener("eie:desk", (ev) => open(ev.detail));
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !typing(ev.target)) {
        ev.preventDefault();
        if (home) document.querySelector(".desk-inline input")?.focus(); else open();
      }
    });
    // arriving from the desk: once the page is set, ring what was found
    let came = null;
    try { came = JSON.parse(sessionStorage.getItem("eie.found") || "null"); sessionStorage.removeItem("eie.found"); } catch {}
    if (ED && came && came.ep === ED && Date.now() - came.t < 120000) {
      const go = () => mark(came.a, came.q);
      if (document.documentElement.dataset.ready) go();
      else new MutationObserver((_, mo) => { if (document.documentElement.dataset.ready) { mo.disconnect(); setTimeout(go, 50); } })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-ready"] });
    }
  }
  window.EieDesk = { open, close, mark, GLASS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
