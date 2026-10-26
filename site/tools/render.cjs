// Render illustrations the way the page shows them, in light and dark, so they can be looked at.
//
//   node site/tools/render.cjs out.png site/art/045/C03.svg [more.svg ...]
//
// Each SVG is placed on a plate with the page's art.css and pictogram sprite; the sheet is
// photographed at 2x. Playwright comes from Codeman's node_modules and drives the system Chrome.
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");

const SITE = path.resolve(__dirname, "..");

async function main([out, ...files]) {
  const sprite = fs.readFileSync(path.join(SITE, "art", "sprite.svg"), "utf8");
  const cell = (f, theme) => `<figure data-theme="${theme}">
      <div class="art">${fs.readFileSync(f, "utf8")}</div><figcaption>${path.basename(f)} · ${theme}</figcaption></figure>`;
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="file://${SITE}/art.css">
    <style>
      body { margin: 0; padding: 16px; background: #F6F1E7; font: 12px system-ui; display: grid;
             grid-template-columns: repeat(2, 400px); gap: 16px; }
      figure { margin: 0; }
      figure[data-theme="dark"] { background: #14161B; color: #ccc; padding: 0; }
      figcaption { padding: 4px 0; }
      .art { width: 400px; }
    </style></head><body>
    <div hidden>${sprite}</div>
    ${files.map((f) => cell(f, "light") + cell(f, "dark")).join("")}
    </body></html>`;
  // Dark cells take the dark palette by scoping the theme variables to the figure.
  const scoped = html.replace("</style>", `
      figure[data-theme="dark"] .art { --plate:#CFC6B2; --shade:#BDB29B; }
    </style>`);
  // Each run gets its own page: a shared temp file let parallel renders crash or photograph each other's plates.
  const tmp = path.join(require("os").tmpdir(), `eie-render-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, scoped);
  const browser = await chromium.launch({
    executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage({ viewport: { width: 864, height: 400 }, deviceScaleFactor: 2 });
  await page.goto("file://" + tmp);
  await page.waitForTimeout(150);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  fs.unlinkSync(tmp);
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
