// Check every edition the way a reader meets it: fitted at seven desktop widths, read on three
// phones, with nothing missing and nothing broken.
//
//   node site/tools/editions-verify.cjs [base-url] [--only=1,45,50] [--widths=1180,1920] [--phones=320] [--out=report.json]
//
// Serve the published site first (sh site/publish.sh /tmp/pub; python3 -m http.server 8745
// --directory /tmp/pub). For each edition: the engine's verdict at each width (every band's columns
// ending on its last line), which story fell short and why; on phones, nothing wider than the screen;
// at every width, the minute-by-minute strip's labels and markers clear of each other; on desktops, the
// skyline's teasers clear of the hosts' cut-outs;
// on every load, console errors and files that failed to come.
const fs = require("fs");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

let WIDTHS = [1180, 1280, 1366, 1440, 1600, 1920, 2560];   // --widths= checks fewer, faster
let PHONES = [320, 375, 414];   // --phones= checks fewer

// the minute-by-minute strip: no axis label over another, no marker over another, all inside the strip
// (on a phone a 56-minute episode once printed "0:005:00", and two moments a minute apart one number)
const STRIP = () => {
  const strip = document.querySelector(".strip"), bad = [];
  if (!strip) return bad;
  const sb = strip.getBoundingClientRect();
  const labels = [...strip.querySelectorAll(".strip-axis span")].filter((s) => !s.hidden).map((s) => s.getBoundingClientRect());
  labels.forEach((q, i) => { if (i && q.left < labels[i - 1].right + 2) bad.push("labels"); });
  const marks = [...strip.querySelectorAll(".strip-marks button")].map((b) => b.getBoundingClientRect()).sort((a, b) => a.left - b.left);
  marks.forEach((q, i) => { if (i && q.left < marks[i - 1].right - 0.5) bad.push("markers"); });
  for (const q of [...labels, ...marks]) if (q.left < sb.left - 0.5 || q.right > sb.right + 0.5) bad.push("outside");
  return [...new Set(bad)];
};

// every cross-reference the edition carries is a mark on its page (one lost inside italics once printed
// its raw token instead)
const XREFS = async () => {
  const E = await (await fetch("edition.json")).json();
  const keys = Object.keys(E.xrefs || {});
  return { n: keys.length, missing: keys.filter((k) => !document.getElementById(`xr-${k}`)), raw: /\[\[x\d+\]\]/.test(document.body.textContent) };
};

// the skyline: no teaser's words under a host's cut-out (a word wider than its column once widened the
// column, and "Beethoven" ran under Ajay Shah)
const SKY = () => {
  const cuts = [...document.querySelectorAll(".cutout img")].map((i) => i.getBoundingClientRect()), bad = [];
  for (const part of document.querySelectorAll(".skyline .tease .k, .skyline .tease .w, .skyline .tease .x")) {
    const rg = document.createRange();
    rg.selectNodeContents(part);
    for (const q of rg.getClientRects()) for (const c of cuts)
      if (q.width && q.right > c.left + 1 && q.left < c.right - 1 && q.bottom > c.top + 1 && q.top < c.bottom - 1) bad.push(part.className.split(" ")[0]);
  }
  return [...new Set(bad)];
};

async function main() {
  const args = process.argv.slice(2);
  const base = (args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8745/").replace(/\/?$/, "/");
  const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1];
  const list = await (await fetch(`${base}editions.json`)).json();
  const only = opt("only") ? opt("only").split(",").map(Number) : null;
  if (opt("widths")) WIDTHS = opt("widths").split(",").map(Number);
  if (opt("phones")) PHONES = opt("phones").split(",").map(Number);
  const eds = list.editions.map((e) => e.n).filter((n) => !only || only.includes(n));
  const browser = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const report = [];
  for (const n of eds) {
    const r = { n, widths: {}, phones: {}, errors: [], missing: [] };
    const t0 = Date.now();
    // desktop: one load, then each width by resizing (the paper sets itself again)
    const ctx = await browser.newContext({ viewport: { width: WIDTHS[0], height: 1000 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => r.errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/youtube|ytimg|doubleclick|googlevideo/i.test(m.text())) r.errors.push(m.text()); });
    p.on("response", (x) => { if (x.status() >= 400 && x.url().startsWith(base)) r.missing.push(`${x.status()} ${x.url().slice(base.length)}`); });
    // a resize sets the paper again, and the old page's videos are dropped mid-load: that is not a missing file
    p.on("requestfailed", (x) => { if (x.url().startsWith(base) && !/ERR_ABORTED/.test(x.failure()?.errorText || "")) r.missing.push(`failed ${x.url().slice(base.length)}`); });
    try {
      await p.goto(`${base}${n}/`, { waitUntil: "load", timeout: 60000 });
      for (const w of WIDTHS) {
        if (w !== WIDTHS[0]) {
          await p.evaluate(() => delete document.documentElement.dataset.fit);
          await p.setViewportSize({ width: w, height: 1000 });
        }
        await p.waitForFunction(() => document.documentElement.dataset.fit, null, { timeout: 60000 });
        r.widths[w] = await p.evaluate(() => {
          const fit = document.documentElement.dataset.fit;
          // every story in a row that could not be fitted, with how deep it can go and its words a line
          const short = (window.__eie?.Fit.report || []).filter((x) => x.range !== undefined)
            .map((x) => ({ id: x.id, band: x.band, ok: x.ok, T: x.T, range: x.range, cols: x.cols, wpl: x.wpl, words: x.words, why: x.why }));
          // a picture that came up empty, a crossword left over its column, a headline wider than its story
          const broken = [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src"));
          // anything whose words run past its own box: a headline too wide for its column, a teaser over its cut-out
          const over = [...document.querySelectorAll(".mod, .mod h2, .mod h3, .mod p, .tease, .tease span, .ptitle")]
            .filter((m) => m.scrollWidth > m.clientWidth + 2).map((m) => `${m.closest(".mod")?.id || ""} ${m.tagName.toLowerCase()}.${m.className}`.trim());
          return { fit, short, broken, over, ms: +document.documentElement.dataset.fitms || null };
        });
        r.widths[w].strip = await p.evaluate(STRIP);
        r.widths[w].sky = await p.evaluate(SKY);
        if (w === WIDTHS[0]) r.xrefs = await p.evaluate(XREFS);
      }
    } catch (e) {
      r.errors.push(`desktop: ${e.message.split("\n")[0]}`);
    }
    await ctx.close();
    // phones: article mode, nothing wider than the screen
    for (const w of PHONES) {
      const c = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const q = await c.newPage();
      q.on("pageerror", (e) => r.errors.push(`${w}: ${e.message}`));
      try {
        await q.goto(`${base}${n}/`, { waitUntil: "load", timeout: 60000 });
        await q.waitForSelector("html[data-ready]", { state: "attached", timeout: 30000 });
        r.phones[w] = await q.evaluate(() => {
          const vw = innerWidth, wide = [];
          for (const el of document.querySelectorAll("#paper *")) {
            const b = el.getBoundingClientRect();
            if (b.width && b.right > vw + 1 && getComputedStyle(el).position !== "fixed") wide.push(el.className || el.tagName);
          }
          return { article: document.documentElement.classList.contains("article"), scroll: document.documentElement.scrollWidth, wide: [...new Set(wide)].slice(0, 6) };
        });
        await q.evaluate(() => document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(ok))));
        r.phones[w].strip = await q.evaluate(STRIP);
      } catch (e) {
        r.errors.push(`phone ${w}: ${e.message.split("\n")[0]}`);
      }
      await c.close();
    }
    r.seconds = Math.round((Date.now() - t0) / 1000);
    const bad = Object.entries(r.widths).filter(([, v]) => v.fit !== "ok" || v.over.length || v.broken.length || v.strip.length || v.sky.length);
    const phonesBad = Object.entries(r.phones).filter(([w, v]) => v.scroll > +w || v.wide.length || v.strip.length);
    const xbad = r.xrefs && (r.xrefs.missing.length || r.xrefs.raw);
    r.ok = !bad.length && !phonesBad.length && !xbad && !r.errors.length && !r.missing.length && Object.keys(r.widths).length === WIDTHS.length;
    report.push(r);
    console.log(`${r.ok ? "ok  " : "FAIL"} ${String(n).padStart(3)}  ${r.seconds}s` +
      (bad.length ? `  fit: ${bad.map(([w, v]) => `${w}:${[...v.short.filter((s) => !s.ok).map((s) => s.id), ...v.over.map((o) => `over(${o})`), ...v.broken.map((b) => `broken(${b})`), ...v.strip.map((x) => `strip(${x})`), ...v.sky.map((x) => `sky(${x})`)].join("+") || v.fit}`).join(" ")}` : "") +
      (phonesBad.length ? `  phones: ${phonesBad.map(([w, v]) => `${w}:${v.scroll}px ${v.wide.join(",")}${v.strip.length ? ` strip(${v.strip.join(",")})` : ""}`).join(" ")}` : "") +
      (xbad ? `  xrefs: ${r.xrefs.missing.length} of ${r.xrefs.n} not on the page${r.xrefs.raw ? ", a raw token printed" : ""}` : "") +
      (r.errors.length ? `  errors: ${r.errors.slice(0, 3).join(" | ")}` : "") + (r.missing.length ? `  missing: ${r.missing.slice(0, 4).join(", ")}` : ""));
  }
  await browser.close();
  const out = opt("out");
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  const good = report.filter((r) => r.ok).length;
  console.log(`${good}/${report.length} editions pass`);
  process.exit(good === report.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
