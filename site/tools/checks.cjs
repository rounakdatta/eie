// Checks for the player and the links: each one was a real bug, and each asserts the behaviour a
// person would notice, read off the YouTube player itself rather than off our own flags.
//
//   node site/tools/checks.cjs [url]
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const URL = process.argv[2] || "http://127.0.0.1:8745/";
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

async function page(browser, path = "", vp = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport: vp });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("  pageerror:", e.message));
  await p.goto(URL + path, { waitUntil: "networkidle" });
  await p.waitForSelector("html[data-ready]", { state: "attached" });
  return p;
}
const yt = (p) => p.evaluate(() => { const y = window.__eie.Player.yt; return y?.getCurrentTime ? { t: y.getCurrentTime(), s: y.getPlayerState() } : null; });
async function until(p, fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn)) return true; await p.waitForTimeout(150); } return false; }

(async () => {
  const browser = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });

  // 1. An earlier moment in the same video plays, instead of stopping the moment it starts.
  {
    const p = await page(browser);
    await p.click("#\\30 45-C13 .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1 && window.__eie.Player.yt.getCurrentTime() > 2558);
    await p.click("#\\30 45-C03 .moment");
    await p.waitForTimeout(2500);
    const s = await yt(p);
    const ended = await p.evaluate(() => document.getElementById("dock").hasAttribute("data-ended"));
    check("an earlier moment in the same video plays", s && s.s === 1 && s.t > 455 && s.t < 471 && !ended, `state ${s?.s}, t ${s?.t.toFixed(1)}, ended ${ended}`);
    // 1b. "Again" after "Keep listening" replays the clip rather than stopping at once
    await p.click(".dock-more");
    await p.waitForTimeout(1500);
    await p.click(".dock-replay");
    await p.waitForTimeout(2000);
    const r = await yt(p);
    check("Again after Keep listening replays the clip", r && r.s === 1 && r.t > 455 && r.t < 471, `state ${r?.s}, t ${r?.t.toFixed(1)}`);
    await p.context().close();
  }

  // 2. Closing the player in the reel's pause between clips closes it for good.
  {
    const p = await page(browser);
    await p.click(".actions .moment");
    // wait for the first clip to end: the player pauses while the title still says 1 of 5
    const gap = await until(p, () => /^1 of 5/.test(document.querySelector(".dock-title").textContent) && window.__eie.Player.yt?.getPlayerState?.() === 2, 30000);
    await p.click(".dock-close");
    await p.waitForTimeout(1600);
    const open = await p.evaluate(() => !document.getElementById("dock").hidden);
    const s = await yt(p);
    check("closing in the reel's gap stops the reel", gap && !open && s?.s !== 1, `reached gap ${gap}, dock open ${open}, state ${s?.s}`);
    await p.context().close();
  }

  // 3. Closing the player before it is ready leaves nothing playing out of sight.
  {
    const p = await page(browser);
    await p.click("#\\30 45-C03 .moment");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(5000);
    const s = await yt(p);
    check("closing before the player is ready leaves it silent", !s || s.s !== 1, `state ${s?.s}`);
    await p.context().close();
  }

  // 4. A link to a card lands on it.
  {
    const p = await page(browser, "#045-S03");
    await p.waitForTimeout(600);
    const top = await p.evaluate(() => document.getElementById("045-S03").getBoundingClientRect().top);
    check("a link to a card scrolls to it", top >= 0 && top < 200, `card top at ${Math.round(top)} px`);
    await p.context().close();
  }

  // 5. Keys before the player exists don't throw.
  {
    const p = await page(browser);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.click("#\\30 45-C03 .moment");
    for (const wait of [0, 250, 700, 1400]) {   // before the API, while the player is made, just after
      await p.waitForTimeout(wait);
      for (const k of ["k", "j", "l"]) await p.keyboard.press(k);
      await p.click(".dock-replay").catch(() => {});
    }
    await p.waitForTimeout(400);
    check("keys and Again before the player is ready don't throw", errors.length === 0, errors.join("; "));
    await p.context().close();
  }

  // 6. A reel goes on in a background tab, where animation frames stop and only timers run.
  //    (The reviewer's repro: stub requestAnimationFrame once clip 1 is playing.)
  {
    const p = await page(browser);
    await p.click(".actions .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.waitForTimeout(1500);
    await p.evaluate(() => { window.requestAnimationFrame = () => 0; });
    let overran = 0;
    const reached = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        const s = await p.evaluate(() => { const P = window.__eie.Player; return { title: document.querySelector(".dock-title").textContent, t: P.yt.getCurrentTime() * 100, end: P.cur?.clip[1], playing: P.yt.getPlayerState() === 1 }; });
        if (s.playing && s.t > s.end + 150) overran = Math.max(overran, Math.round((s.t - s.end) / 100));
        if (/^3 of 5/.test(s.title)) return true;
        await p.waitForTimeout(250);
      }
      return false;
    })();
    check("in a background tab the reel still steps from clip to clip", reached && overran === 0, `reached clip 3: ${reached}, a clip ran ${overran} s past its end`);
    await p.context().close();
  }

  // 7. Pausing the reel and playing again carries on with it.
  {
    const p = await page(browser);
    await p.click(".actions .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.waitForTimeout(3000);
    await p.click(".dock-toggle");
    await p.waitForTimeout(2000);
    await p.click(".dock-toggle");
    const on = await until(p, () => /^2 of 5/.test(document.querySelector(".dock-title").textContent), 25000);
    check("pausing the reel and playing again carries on to clip 2", on);
    await p.context().close();
  }

  // 8. Closing the player leaves the page where it is, by mouse and by tap.
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = vp.width < 500;
    const ctx = await browser.newContext({ viewport: vp, isMobile: phone, hasTouch: phone });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached" });
    phone ? await p.tap(".actions .moment") : await p.click(".actions .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.evaluate(() => document.getElementById("laughs").scrollIntoView());
    await p.waitForTimeout(400);
    const before = await p.evaluate(() => Math.round(scrollY));
    phone ? await p.tap(".dock-close") : await p.click(".dock-close");
    await p.waitForTimeout(800);
    const after = await p.evaluate(() => Math.round(scrollY));
    check(`closing the player leaves the page where it is (${vp.width} px)`, Math.abs(after - before) < 5, `scrollY ${before} → ${after}`);
    await ctx.close();
  }

  // 9. A first load of YouTube's script slower than the timeout still lets a later click play.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    let n = 0;
    await p.route(/youtube\.com\/iframe_api/, async (r) => { n++; if (n === 1) await new Promise((res) => setTimeout(res, 13500)); r.continue(); });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached" });
    await p.evaluate(() => document.getElementById("045-C03").querySelector(".moment").click());
    await p.waitForTimeout(16000);
    await p.evaluate(() => document.getElementById("045-C06").querySelector(".moment").click());
    const ok = await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1, 14000);
    check("after a slow first load of YouTube's script, the next click plays", ok);
    await ctx.close();
  }

  // 10. Esc closes the player from anywhere; focus that was elsewhere on the page stays there.
  //     (The reviewer's repro: a keyboard user tabbed down to a story, and a reader who clicked some
  //     text; after Esc, Tab and Space must carry on from where they were, not from the reel button.)
  {
    const p = await page(browser);
    await p.focus(".actions .moment");
    await p.keyboard.press("Enter");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.evaluate(() => document.getElementById("045-S03").querySelector(".moment").focus());
    await p.keyboard.press("Escape");
    const where = await p.evaluate(() => document.activeElement.closest("article")?.id || document.activeElement.className);
    check("Esc leaves keyboard focus where it was", where === "045-S03", `focus on ${where}`);
    await p.context().close();
  }
  {
    const p = await page(browser);
    await p.click(".actions .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.evaluate(() => document.getElementById("stories").scrollIntoView());
    const box = await p.evaluate(() => { const r = document.getElementById("045-S05").querySelector(".summary").getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; });
    await p.mouse.click(box.x, box.y);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    await p.keyboard.press(" ");
    await p.waitForTimeout(1500);
    const reopened = await p.evaluate(() => !document.getElementById("dock").hidden);
    check("after Esc, Space scrolls the page instead of restarting the reel", !reopened, `dock reopened: ${reopened}`);
    await p.context().close();
  }

  // 11. A mouse user who clicked Pause and Play in the dock, then scrolled on and pressed Esc, stays put.
  //     (The reviewer's repro: Chrome leaves focus on a clicked button, which passed for keyboard focus.)
  {
    const p = await page(browser, "", { width: 1440, height: 900 });
    await p.click(".actions .moment");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.click(".dock-toggle");
    await p.waitForTimeout(600);
    await p.click(".dock-toggle");
    await p.waitForTimeout(600);
    await p.mouse.move(400, 400);
    await p.evaluate(() => scrollTo(0, 17000));
    await p.waitForTimeout(400);
    const before = await p.evaluate(() => Math.round(scrollY));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(600);
    const after = await p.evaluate(() => Math.round(scrollY));
    check("Esc after clicking the dock's buttons leaves the page where it is", Math.abs(after - before) < 5, `scrollY ${before} → ${after}`);
    await p.context().close();
  }

  // 12. And the other side of it: a keyboard user in the dock who closes it gets focus back on what
  //     they started it from. (Without this, the checks above would pass if focus were never restored.)
  {
    const p = await page(browser);
    await p.focus(".actions .moment");
    await p.keyboard.press("Enter");
    await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1);
    await p.focus(".dock-close");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(300);
    const back = await p.evaluate(() => document.activeElement.matches(".actions .moment"));
    check("a keyboard close from inside the dock returns focus to what started it", back);
    await p.context().close();
  }

  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
