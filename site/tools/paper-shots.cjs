// Photograph the newspaper: each page whole on desktop, page one on a phone, and a moment playing.
//
//   node site/tools/paper-shots.cjs <out-dir>
const fs = require("fs");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const OUT = process.argv[2];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  const open = async (vp, mobile) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1.5, isMobile: !!mobile, hasTouch: !!mobile });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log("pageerror:", e.message));
    await p.goto("http://127.0.0.1:8745/45/", { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit], html.article[data-ready]", { state: "attached", timeout: 30000 });
    await p.evaluate(() => document.fonts.ready);
    // scroll the whole paper once, as a reader would, so every lazy picture has loaded
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
    await p.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => console.log("some images did not load"));
    await p.waitForTimeout(800);
    await p.evaluate(() => { const g = document.querySelector(".pager"); if (g) g.hidden = true; });
    return { ctx, p };
  };
  { // desktop: every sheet whole
    const { ctx, p } = await open({ width: 1440, height: 900 });
    for (const [id, name] of [["p1", "1-front-page"], ["p2", "2-the-five-fallacies"], ["p3", "3-stories"], ["p4", "4-books-laughs-quiz"]]) {
      await p.evaluate((id) => document.getElementById(id).scrollIntoView(), id);
      await p.waitForTimeout(900);
      await (await p.$(`#${id}`)).screenshot({ path: `${OUT}/${name}.png` });
      console.log(name);
    }
    // the player at work, from a moving picture
    await p.evaluate(() => document.getElementById("monkey").scrollIntoView({ block: "center" }));
    await p.waitForTimeout(800);
    await p.click("#monkey .watch");
    for (let i = 0; i < 60; i++) { await p.waitForTimeout(250); if (await p.evaluate(() => window.__eie.Player.yt?.getPlayerState?.() === 1 && document.querySelectorAll(".dock-caption .w.said").length > 8)) break; }
    await p.screenshot({ path: `${OUT}/5-playing-a-moment.png` });
    console.log("5-playing-a-moment");
    await ctx.close();
  }
  { // phone: page one, whole
    const { ctx, p } = await open({ width: 390, height: 844 }, true);
    await (await p.$("#p1")).screenshot({ path: `${OUT}/6-phone-front-page.png` });
    console.log("6-phone-front-page");
    await ctx.close();
  }
  await b.close();
})();
