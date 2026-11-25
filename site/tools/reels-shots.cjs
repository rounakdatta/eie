// Photographs of the newsreel at every size it must look right at: three phones (with a notch's safe
// areas), a phone on its side, a tablet and two desktops, in light and dark; and its sheet, its end, and
// the ways in (the front page's band, an edition's bar). YouTube is blocked unless --films: the layout
// is the point, and the posters show where the films would be.
//
//   node site/tools/reels-shots.cjs [base-url] [--films] [--only=phone,desktop] [--out=dir]
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8790/").replace(/\/?$/, "/");
const FILMS = args.includes("--films");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const OUT = (args.find((a) => a.startsWith("--out=")) || "--out=/home/rounak/personal/eie-reels/shots").slice(6);
const CHROME = process.env.CHROME || "/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome";
const NUGGETS = (process.env.NUGGETS || "045-S01,012-R27,088-J11,097-C10").split(",");
const LOOK = (args.find((a) => a.startsWith("--look=")) || "").slice(7);   // a design candidate, while choosing
const SCHEMES = (args.find((a) => a.startsWith("--schemes=")) || "--schemes=light,dark").slice(10).split(",");

const SIZES = [
  { name: "phone-360", viewport: { width: 360, height: 800 }, mobile: true, inset: [24, 0, 16, 0] },
  { name: "phone-390", viewport: { width: 390, height: 844 }, mobile: true, inset: [47, 0, 34, 0] },
  { name: "phone-430", viewport: { width: 430, height: 932 }, mobile: true, inset: [59, 0, 34, 0] },
  { name: "phone-se", viewport: { width: 375, height: 667 }, mobile: true, inset: [20, 0, 0, 0] },
  { name: "landscape-844", viewport: { width: 844, height: 390 }, mobile: true, inset: [0, 47, 21, 47] },
  { name: "tablet-768", viewport: { width: 768, height: 1024 }, mobile: true, inset: [24, 0, 20, 0] },
  { name: "desktop-1440", viewport: { width: 1440, height: 900 } },
  { name: "desktop-1920", viewport: { width: 1920, height: 1080 } },
].filter((s) => !ONLY.length || ONLY.some((o) => s.name.startsWith(o)));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  const problems = [];
  for (const size of SIZES) {
    for (const scheme of SCHEMES) {
      const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.mobile ? 2 : 1, isMobile: !!size.mobile, hasTouch: !!size.mobile, colorScheme: scheme });
      if (!FILMS) await ctx.route(/youtube|ytimg|googlevideo|doubleclick|google\.com/, (r) => r.abort());
      const page = await ctx.newPage();
      page.on("pageerror", (e) => problems.push(`${size.name}/${scheme}: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error" && !/youtube|ERR_FAILED|net::/.test(m.text())) problems.push(`${size.name}/${scheme} console: ${m.text().slice(0, 160)}`); });
      if (size.inset) {
        try {
          const cdp = await ctx.newCDPSession(page);
          const [top, right, bottom, left] = size.inset;
          await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top, right, bottom, left } });
        } catch { /* an older Chrome: no safe areas */ }
      }
      for (const id of NUGGETS) {
        await page.goto(`${BASE}reels/?n=${id}${LOOK ? `&look=${LOOK}` : ""}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`.reel[aria-labelledby="h-${id}"]`, { timeout: 20000 }).catch(() => problems.push(`${size.name}: ${id} never showed`));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(FILMS ? 3500 : 400);
        // what a reader can't see is a defect: text running out of its reel, or under the bars
        const bad = await page.evaluate(() => {
          const out = [], r = document.querySelector(".reel[data-k]"), top = document.querySelector("#bar").getBoundingClientRect().bottom;
          const bottom = document.querySelector("#ctl").getBoundingClientRect().top, H = innerHeight;
          for (const el of r.querySelectorAll(".kicker, .head, .screen, .foot, .said, .dek, .src")) {
            const b = el.getBoundingClientRect();
            if (!b.height || getComputedStyle(el).display === "none") continue;
            const vis = b.top - (r.getBoundingClientRect().top);
            if (b.top < top - 1 - 0 && b.bottom > 0) out.push(`${el.className.split(" ")[0]} under the top bar (${Math.round(top - b.top)}px)`);
            if (b.bottom > bottom + 1 && b.top < H) out.push(`${el.className.split(" ")[0]} under the controls (${Math.round(b.bottom - bottom)}px)`);
            if (b.right > innerWidth + 1 || b.left < -1) out.push(`${el.className.split(" ")[0]} off the side`);
          }
          const s = document.querySelector(".reel[data-k] .screen").getBoundingClientRect();
          if (s.width < 200 || s.height < 200) out.push(`the film is ${Math.round(s.width)}×${Math.round(s.height)}, under YouTube's 200×200`);
          return out;
        });
        for (const b of bad) problems.push(`${size.name}/${scheme} ${id}: ${b}`);
        await page.screenshot({ path: path.join(OUT, `${LOOK ? LOOK + "-" : ""}${size.name}-${scheme}-${id}.png`) });
      }
      if (scheme === "light" && !LOOK) {
        await page.click("#which");
        await page.waitForSelector("#sheet:not([hidden]) .chips", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${size.name}-${scheme}-sheet.png`) });
      }
      await ctx.close();
    }
  }
  // the ways in: the front page's band and an edition's bar
  for (const size of LOOK ? [] : SIZES.filter((s) => ["phone-390", "desktop-1440"].includes(s.name))) {
    const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.mobile ? 2 : 1, isMobile: !!size.mobile, hasTouch: !!size.mobile });
    await ctx.route(/youtube|ytimg|googlevideo|doubleclick/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#reelband:not([hidden])", { timeout: 15000 }).catch(() => problems.push(`${size.name}: the front page's newsreel band never showed`));
    const band = await page.$("#reelband");
    if (band) { await band.scrollIntoViewIfNeeded(); await page.waitForTimeout(600); await band.screenshot({ path: path.join(OUT, `${size.name}-front-band.png`) }); }
    await page.goto(`${BASE}45/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".edbar .reelgo:not([hidden])", { timeout: 20000 }).catch(() => problems.push(`${size.name}: the edition bar's Newsreel link never showed`));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${size.name}-edition-bar.png`), clip: { x: 0, y: 0, width: size.viewport.width, height: Math.min(260, size.viewport.height) } });
    await ctx.close();
  }
  await browser.close();
  console.log(problems.length ? problems.join("\n") : "no problems seen");
  console.log(`shots in ${OUT}`);
})();
