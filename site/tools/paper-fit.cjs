// Report how each band of the newspaper was fitted at a width: depth, column ends, tracking.
//
//   node site/tools/paper-fit.cjs [width]
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
(async () => {
  const W = +(process.argv[2] || 1440);
  const b = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const p = await b.newPage({ viewport: { width: W, height: 1000 } });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  p.on("console", (m) => { if (["error", "warning"].includes(m.type())) console.log("console:", m.text()); });
  await p.goto("http://127.0.0.1:8745/paper/", { waitUntil: "networkidle" });
  await p.waitForSelector("html[data-ready]", { state: "attached", timeout: 30000 });
  const r = await p.evaluate(() => {
    const out = { fit: document.documentElement.dataset.fit, ms: document.documentElement.dataset.fitms, bands: [] };
    for (const band of document.querySelectorAll(".band[data-fit]")) {
      const mods = [...band.querySelectorAll(":scope > .mod")];
      const bottoms = mods.map((m) => Math.round(m.getBoundingClientRect().bottom));
      const cols = [];
      for (const m of mods) {
        const t = m.querySelector(":scope > .text");
        if (!t) continue;
        const tb = t.getBoundingClientRect(), n = +t.style.columnCount || +t.dataset.cols, colW = (tb.width + 22) / n, bb = new Map();
        for (const el of t.children) for (const q of el.getClientRects()) { if (q.height < 1) continue; const c = Math.floor((q.left - tb.left + 2) / colW); bb.set(c, Math.max(bb.get(c) ?? 0, q.bottom)); }
        cols.push({ id: m.id || m.className, n, short: [...bb.values()].map((y) => Math.round(tb.bottom - y)), track: t.style.letterSpacing || "0" });
      }
      out.bands.push({ page: band.closest(".page").id, depth: band.dataset.depth, bottoms, cols, short: mods.filter((m) => m.dataset.fit === "short").map((m) => m.id || m.className) });
    }
    out.from1 = document.querySelector("#from1 .text")?.children.length ?? "removed";
    return out;
  });
  console.log("fit:", r.fit, "ms:", r.ms, "| from1 blocks:", r.from1);
  for (const x of r.bands) console.log(`${x.page} depth ${x.depth} | module bottoms ${x.bottoms.join(",")} | ${x.cols.map((c) => `${c.id}[${c.n}] short:${c.short.join("/")} tr:${c.track}`).join("  ")}${x.short.length ? "  SHORT: " + x.short.join(",") : ""}`);
  await b.close();
})();
