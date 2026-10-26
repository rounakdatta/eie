// The screenshots that show the design: each section at its best size, phone and desktop, light and dark,
// plus the player mid-sentence and the big-idea drawer.
//
//   node site/tools/gallery.cjs <out-dir> [url]
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

async function main(out, url = "http://127.0.0.1:8745/") {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  const shots = [
    // [file, device, theme, prepare]
    ["01-desktop-top", "desktop", "light", null],
    ["02-desktop-ideas", "desktop", "light", "#ch-2"],
    ["03-desktop-stories", "desktop", "light", "#\\30 45-S02"],
    ["04-desktop-shelf", "desktop", "light", "#shelf"],
    ["05-desktop-laughs", "desktop", "light", "#laughs"],
    ["06-desktop-remember", "desktop", "light", "#remember"],
    ["07-desktop-onward", "desktop", "light", "#onward"],
    ["08-desktop-dark-top", "desktop", "dark", null],
    ["09-desktop-dark-ideas", "desktop", "dark", "#ch-4"],
    ["10-phone-top", "phone", "light", null],
    ["11-phone-ideas", "phone", "light", "#\\30 45-C06"],
    ["12-phone-story", "phone", "light", "#\\30 45-S03"],
    ["13-phone-dark-shelf", "phone", "dark", "#shelf"],
  ];
  const devices = {
    desktop: { viewport: { width: 1440, height: 900 } },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  };
  for (const [file, device, theme, at] of shots) {
    const ctx = await browser.newContext({ ...devices[device], colorScheme: theme });
    // The top of the page as a stranger meets it; everywhere else, as someone who has played a moment.
    if (!/top$/.test(file)) await ctx.addInitScript(() => localStorage.setItem("eie.played", "true"));
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached" });
    await p.evaluate(() => document.fonts.ready);
    if (at) await p.evaluate((sel) => { const el = document.querySelector(sel); scrollTo(0, el.getBoundingClientRect().top + scrollY - 76); }, at);
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(out, `${file}.png`) });
    await ctx.close();
  }
  // the player, mid-sentence, on desktop and phone
  for (const device of ["desktop", "phone"]) {
    const ctx = await browser.newContext({ ...devices[device], colorScheme: "light" });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached" });
    await p.evaluate(() => { const el = document.getElementById("045-C12"); scrollTo(0, el.getBoundingClientRect().top + scrollY - 76); });
    await p.click("#\\30 45-C12 .moment");
    for (let i = 0; i < 40 && (await p.evaluate(() => document.querySelectorAll(".dock-caption .w.said").length)) < 9; i++) await p.waitForTimeout(250);
    await p.screenshot({ path: path.join(out, device === "desktop" ? "14-desktop-player.png" : "15-phone-player.png") });
    await ctx.close();
  }
  // a big idea across the show
  {
    const ctx = await browser.newContext({ ...devices.desktop, colorScheme: "light" });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached" });
    await p.evaluate(() => document.getElementById("045-C12").scrollIntoView({ block: "center" }));
    await p.click("#\\30 45-C12 .big-link");
    await p.waitForTimeout(500);
    await p.evaluate(() => { const d = document.getElementById("drawer"); d.scrollTop = d.querySelector("h3").offsetTop - 40; });
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(out, "16-desktop-big-idea.png") });
    await ctx.close();
  }
  await browser.close();
  console.log(fs.readdirSync(out).join("\n"));
}

main(...process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
