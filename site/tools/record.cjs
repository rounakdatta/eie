// Record a walkthrough of the page as a video: what a first visit looks like, played for real.
//
//   node site/tools/record.cjs <out-dir> [url]
//
// Headless Chrome records no sound, so it shows what you'd see: clips starting at their moment,
// words lighting up, the drawer, the shelf, the deck.
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

async function main(out, url = "http://127.0.0.1:8745/") {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  const size = { width: 1280, height: 800 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
  const p = await ctx.newPage();
  const pause = (ms) => p.waitForTimeout(ms);
  const glide = async (to, ms = 1400) => {   // a smooth scroll to an element, as a person would
    await p.evaluate(async ([sel, ms]) => {
      const el = typeof sel === "string" ? document.querySelector(sel) : null;
      const target = el ? el.getBoundingClientRect().top + scrollY - 70 : sel;
      const start = scrollY, t0 = performance.now();
      await new Promise((done) => {
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          scrollTo(0, start + (target - start) * e);
          k < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    }, [to, ms]);
  };
  const waitPlaying = async () => {
    for (let i = 0; i < 30; i++) {
      if (await p.evaluate(() => !!document.querySelector(".dock-caption .w.said"))) return;
      await pause(300);
    }
  };

  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForSelector("html[data-ready]", { state: "attached" });
  await p.evaluate(() => document.fonts.ready);
  await pause(1800);

  // the ribbon: every episode, hover one
  const bars = await p.$$(".ribbon button");
  for (const i of [9, 20, 44]) { const b = await bars[i].boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height - 4, { steps: 8 }); await pause(900); }
  await p.mouse.move(640, 400, { steps: 6 });
  await pause(400);

  // the five fallacies, in their words
  const reel = await p.$(".actions .moment");
  const rb = await reel.boundingBox();
  await p.mouse.move(rb.x + 40, rb.y + rb.height / 2, { steps: 10 });
  await pause(300);
  await reel.click();
  await waitPlaying();
  await pause(9000);

  // the conversation strip: read along, then on to the ideas
  await glide(".strip-wrap", 900);
  const turns = await (await p.$(".strip-turns")).boundingBox();
  for (const f of [.2, .41, .63]) { await p.mouse.move(turns.x + turns.width * f, turns.y + 12, { steps: 14 }); await pause(900); }
  await p.click(".dock-close");
  await glide("#ch-2", 1600);
  await pause(1200);
  await p.click("#\\30 45-C03 .moment");
  await waitPlaying();
  await pause(6000);
  await p.click(".dock-close");

  // a big idea, across the whole show
  await p.click("#\\30 45-C03 .big-link");
  await pause(1600);
  await p.evaluate(() => { const d = document.getElementById("drawer"); d.scrollTo({ top: d.scrollHeight * .32, behavior: "smooth" }); });
  await pause(1400);
  await p.click("#drawer .src:not(.here) .moment");
  await waitPlaying();
  await pause(5500);
  await p.keyboard.press("Escape");
  await pause(500);
  await p.keyboard.press("Escape");

  // a story, the whole of it
  await glide("#stories", 1800);
  await glide("#\\30 45-S01", 900);
  await pause(1500);
  const whole = (await p.$$("#\\30 45-S01 .moment"))[1];
  await whole.click();
  await waitPlaying();
  await pause(5000);
  await p.click(".dock-close");

  // the shelf
  await glide("#shelf", 1600);
  await pause(1200);
  await p.click("#\\30 45-R14 .jacket");
  await pause(400);
  await glide(".work-detail", 900);
  await pause(2600);

  // laughs, then remembering
  await glide("#laughs", 1400);
  await pause(1600);
  await glide("#remember", 1400);
  await pause(1200);
  await p.click(".flash .reveal");
  await pause(1800);
  await p.click('.flash .grade button:has-text("Knew it")');
  await pause(1400);

  // onward
  await glide("#onward", 1600);
  await pause(1600);
  await glide(".thread", 1200);
  await pause(2000);

  const video = p.video();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
}

main(...process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
