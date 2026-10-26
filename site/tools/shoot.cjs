// Photograph the page the way people meet it: phone, narrow phone, desktop; light and dark.
//
//   node site/tools/shoot.cjs <out-dir> [url] [--only=desktop,phone] [--themes=light,dark] [--at=#ideas,#stories]
//
// Writes one viewport shot per device × theme × anchor, and logs console errors, so a broken page
// can't hide behind a pretty screenshot.
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  laptop: { viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  narrow: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  landscape: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function main() {
  const args = process.argv.slice(2);
  const out = args[0];
  const url = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8745/";
  const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1]?.split(",") || d;
  const only = opt("only", ["desktop", "phone"]);
  const themes = opt("themes", ["light"]);
  const at = opt("at", ["top"]);
  const full = args.includes("--full");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  for (const name of only) {
    for (const theme of themes) {
      const ctx = await browser.newContext({ ...DEVICES[name], colorScheme: theme });
      const page = await ctx.newPage();
      page.on("console", (m) => { if (m.type() === "error") console.log(`[${name}/${theme}] console: ${m.text()}`); });
      page.on("pageerror", (e) => console.log(`[${name}/${theme}] error: ${e.message}`));
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("html[data-ready]", { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      for (const a of at) {
        if (a !== "top") await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }), a);
        else await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(250);
        const file = path.join(out, `${name}-${theme}-${a.replace(/[^a-z0-9-]/gi, "") || "top"}.png`);
        await page.screenshot({ path: file, fullPage: full });
        console.log(file);
      }
      await ctx.close();
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
