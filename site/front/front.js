// The archive: every edition, the threads through them, and a search. Reads editions.json, which
// build-paper.py writes (site/editions/index.json) and publish.sh puts beside this page.

const $ = (s) => document.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  for (const k of kids.flat(9)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

const day = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const thumb = (e) => h("span", { class: "pic" }, h("img", { src: `${e.n}/media/${e.thumb || e.poster}`, alt: "", loading: "lazy", decoding: "async" }));

function card(e, why) {
  return h("a", { class: "card", href: `${e.n}/` }, thumb(e),
    h("span", { class: "no t" }, `No. ${e.n} · ${day(e.date)}`),
    h("span", { class: "hd" }, e.head),
    why ? h("span", { class: "why" }, why) : h("span", { class: "dk" }, e.deck),
    h("span", { class: "ep" }, `Episode: ${e.title}`));
}

/* Threads as tabs: arrow keys move between them, and the address remembers the one open. */
function threads(list, byN) {
  const tabs = $("#tabs"), panel = $("#thread");
  const show = (t, focus) => {
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.id === t.id));
    const sel = [...tabs.children].find((b) => b.dataset.id === t.id);
    panel.setAttribute("aria-labelledby", sel.id);
    if (focus) sel.focus({ preventScroll: true });
    // bring the tab into the strip's view sideways only: scrollIntoView also scrolled the page to it, so
    // the archive opened halfway down, at the threads, past its own nameplate
    const tr = tabs.getBoundingClientRect(), sr = sel.getBoundingClientRect();
    if (sr.left < tr.left) tabs.scrollLeft -= tr.left - sr.left + 8;
    else if (sr.right > tr.right) tabs.scrollLeft += sr.right - tr.right + 8;
    const path = t.path.filter((s) => byN.has(s.episode));
    panel.replaceChildren(
      h("div", {}, h("h3", {}, t.name), h("p", { class: "summary" }, t.summary), h("p", { class: "count" }, `${path.length} editions, in order`)),
      h("ol", { class: "path" }, path.map((s, k) => {
        const e = byN.get(s.episode);
        return h("li", {}, h("a", { href: `${e.n}/` }, h("span", { class: "step t", "aria-hidden": "true" }, String(k + 1)), thumb(e),
          h("span", {}, h("span", { class: "no t" }, `No. ${e.n} · ${day(e.date)}`), h("span", { class: "hd" }, e.head), h("span", { class: "why" }, s.why))));
      })));
    history.replaceState(null, "", `#${t.id}`);
  };
  list.forEach((t, i) => {
    const b = h("button", { type: "button", role: "tab", id: `tab-${t.id}`, "data-id": t.id, "aria-controls": "thread", "aria-selected": "false", tabindex: "-1" }, t.name.split(":")[0]);
    b.addEventListener("click", () => show(t));
    b.addEventListener("keydown", (ev) => {
      const k = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
      if (!k) return;
      ev.preventDefault();
      show(list[(i + k + list.length) % list.length], true);
    });
    tabs.append(b);
  });
  // the tabs take one tab stop between them
  tabs.addEventListener("focusin", () => { for (const b of tabs.children) b.tabIndex = b.getAttribute("aria-selected") === "true" ? 0 : -1; });
  const want = list.find((t) => `#${t.id}` === location.hash) || list[0];
  show(want);
  for (const b of tabs.children) b.tabIndex = b.getAttribute("aria-selected") === "true" ? 0 : -1;
}

/* Every edition, year by year, and a search across their headlines, stories and titles. */
function every(eds) {
  // accents and case aside, and a typed ' or " finds the printed ’ or ”
  const fold = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  const years = new Map();
  for (const e of eds) {
    const y = e.date.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    e.card = card(e);
    e.hay = fold([e.n, e.title, e.head, e.deck, ...(e.sections || []), ...(e.stories || [])].join(" "));
    years.get(y).push(e);
  }
  const blocks = [...years].map(([y, list]) => ({ list, el: h("div", { class: "year" }, h("h3", { class: "t" }, y), h("div", { class: "cards" }, list.map((e) => e.card))) }));
  const none = h("p", { class: "none", hidden: true }, "No edition matches. Try fewer words.");
  $("#all").replaceChildren(...blocks.map((b) => b.el), none);
  const found = $("#found");
  let timer = 0;
  const filter = () => {
    const words = fold($("#q").value).split(/\s+/).filter(Boolean);
    let n = 0;
    for (const b of blocks) {
      let any = false;
      for (const e of b.list) { const hit = words.every((w) => e.hay.includes(w)); e.card.hidden = !hit; any ||= hit; n += hit; }
      b.el.hidden = !any;
    }
    none.hidden = n > 0;
    found.textContent = words.length ? `${n} of ${eds.length} editions` : `${eds.length} editions, oldest first`;
  };
  $("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(filter, 120); });
  filter();
}

async function main() {
  const data = await (await fetch("editions.json")).json();
  const eds = data.editions, byN = new Map(eds.map((e) => [e.n, e]));
  $("#count").textContent = `${eds.length} editions · June 2023 to December 2025`;
  $("#start").replaceChildren(...(data.startHere || []).filter((s) => byN.has(s.episode)).slice(0, 6).map((s) => card(byN.get(s.episode), s.why)));
  if (!$("#start").children.length) $("#start").closest("section").hidden = true;
  const ts = (data.threads || []).filter((t) => t.path.some((s) => byN.has(s.episode)));
  if (ts.length) threads(ts, byN); else $("#tabs").closest("section").hidden = true;
  every(eds);
}

main().catch((err) => { console.error(err); $("#all").append(h("p", { class: "none" }, "The list of editions couldn’t load.")); });
