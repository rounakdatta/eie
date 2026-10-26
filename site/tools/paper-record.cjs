// Record a walkthrough of the newspaper: page one, a moving picture played with sound, the jump to
// page two, the stories, and the crossword (a solved clue's mark playing its moment).
//
//   node site/tools/paper-record.cjs <out-dir> [url]
const fs = require("fs");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

async function main(out, url = "http://127.0.0.1:8745/paper/") {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  const size = { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
  await ctx.addInitScript(() => localStorage.removeItem("eie.cw.45"));
  const p = await ctx.newPage();
  const pause = (ms) => p.waitForTimeout(ms);
  const glide = (y, ms = 1400) => p.evaluate(async ([y, ms]) => {
    const s = scrollY, t0 = performance.now();
    await new Promise((done) => { const f = (t) => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, s + (y - s) * e); k < 1 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); });
  }, [y, ms]);
  const topOf = (sel) => p.evaluate((sel) => { const el = sel.startsWith("#") ? document.getElementById(sel.slice(1)) : document.querySelector(sel); return el.getBoundingClientRect().top + scrollY - 20; }, sel);
  const playing = async () => { for (let i = 0; i < 60 && !(await p.evaluate(() => window.__eie?.Player.yt?.getPlayerState?.() === 1)); i++) await pause(250); };

  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 30000 });
  await p.evaluate(() => { const g = document.querySelector(".pager"); if (g) g.style.opacity = "0"; });
  await pause(2600);                                   // page one, as it lands
  await glide(380, 1500); await pause(1800);           // the lead and its columns
  await p.mouse.move(1300, 520, { steps: 12 });
  await p.click("#nile .watch");                       // a moving picture, heard
  await playing(); await pause(6500);
  await p.click(".dock-close"); await pause(400);
  await glide(await topOf(".jump") - 500, 1200); await pause(900);
  await p.click(".jump a");                            // continued on page 2
  await pause(2200);
  await glide(await topOf("#p2"), 1600); await pause(1400);
  await glide(await topOf("#f2"), 1600); await pause(1600);
  await glide(await topOf("#p3"), 1800); await pause(2400);   // stories, their pictures moving
  await glide(await topOf("#crossword"), 2200); await pause(1200);
  await p.click('.cw-clue[data-k="17a"]'); await pause(300);
  await p.keyboard.type("NILE", { delay: 260 }); await pause(900);
  await p.click('.cw-clue[data-k="14a"]'); await pause(300);
  await p.keyboard.type("RYAN", { delay: 260 }); await pause(1200);
  await p.click('.cw-clue[data-k="14a"] .say');        // a solved clue's mark: the moment itself
  await playing(); await pause(6000);
  await p.click(".dock-close"); await pause(600);
  const video = p.video();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
}

main(...process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
