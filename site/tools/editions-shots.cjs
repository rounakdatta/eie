// Photograph editions for review: each page on a desktop, and the whole edition on a phone.
//
//   node site/tools/editions-shots.cjs <out-dir> [base-url] [--only=1,45] [--width=1440] [--phone=390]
//
// Writes NNN-p1.png … NNN-p4.png (each page at the desktop width) and NNN-phone-0.png, -1.png … (the edition
// read top to bottom at the phone width). Lazy pictures are scrolled into view first, so none is
// blank in a full-page shot.
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

async function settle(p) {
  await p.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); }
    scrollTo(0, 0);
  });
  await p.waitForTimeout(900);
  // the docks out of the way, and every film held on its frame: a playing video comes out blank in a
  // capture, and scrolling an element into view to photograph it would set it playing again
  await p.evaluate(() => {
    for (const el of document.querySelectorAll(".pager, .dock")) el.style.display = "none";
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    for (const v of document.querySelectorAll("video")) v.pause();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const out = args[0];
  const base = (args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8745/").replace(/\/?$/, "/");
  const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
  const only = opt("only") ? opt("only").split(",").map(Number) : null;
  const list = (await (await fetch(`${base}editions.json`)).json()).editions.map((e) => e.n).filter((n) => !only || only.includes(n));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  for (const n of list) {
    const id = String(n).padStart(3, "0");
    const d = await browser.newPage({ viewport: { width: +opt("width", 1440), height: 1000 } });
    await d.goto(`${base}${n}/`, { waitUntil: "load", timeout: 60000 });
    await d.waitForSelector("html[data-fit]", { state: "attached", timeout: 60000 });
    await settle(d);
    for (const [i, el] of (await d.$$(".page")).entries()) await el.screenshot({ path: path.join(out, `${id}-p${i + 1}.png`) });
    await d.close();
    const m = await browser.newPage({ viewport: { width: +opt("phone", 390), height: 844 }, isMobile: true, hasTouch: true });
    await m.goto(`${base}${n}/`, { waitUntil: "load", timeout: 60000 });
    await m.waitForSelector("html[data-ready]", { state: "attached", timeout: 60000 });
    await settle(m);
    // in pieces: a single capture stops drawing at 16,384 px, and an edition on a phone runs to 30,000
    const H = await m.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0, k = 0; y < H; y += 12000, k++)
      await m.screenshot({ path: path.join(out, `${id}-phone-${k}.png`), fullPage: true, clip: { x: 0, y, width: +opt("phone", 390), height: Math.min(12000, H - y) } });
    await m.close();
    console.log(id);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
