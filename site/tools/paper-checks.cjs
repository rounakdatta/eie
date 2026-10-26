// Checks for the newspaper: the type fits, and everything a reader can press does what it says.
//
//   node site/tools/paper-checks.cjs [url]
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const URL = process.argv[2] || "http://127.0.0.1:8745/paper/";
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
async function until(p, fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn)) return true; await p.waitForTimeout(150); } return false; }

/* Every column of every fitted band ends on the band's last line, measured from the page itself. */
async function columnsFlush(p) {
  return p.evaluate(() => {
    const bad = [];
    for (const band of document.querySelectorAll(".band[data-fit]")) {
      const mods = [...band.querySelectorAll(":scope > .mod")];
      const bottom = Math.max(...mods.map((m) => m.getBoundingClientRect().bottom));
      for (const m of mods) {
        if (Math.abs(m.getBoundingClientRect().bottom - bottom) > 1) bad.push(`${m.id || "module"} ends ${Math.round(bottom - m.getBoundingClientRect().bottom)}px short`);
        const t = m.querySelector(":scope > .text");
        if (!t) continue;
        const tb = t.getBoundingClientRect(), n = +t.style.columnCount, colW = (tb.width + 22) / n, cols = new Map();
        for (const el of t.children) for (const q of el.getClientRects()) { if (q.height < 1) continue; const c = Math.floor((q.left - tb.left + 2) / colW); cols.set(c, Math.max(cols.get(c) ?? 0, q.bottom)); }
        if (cols.size !== n) bad.push(`${m.id}: ${cols.size} of ${n} columns have text`);
        for (const [c, y] of cols) if (Math.abs(y - tb.bottom) > 1.5) bad.push(`${m.id} column ${c + 1} ends ${Math.round(tb.bottom - y)}px short`);
      }
    }
    return bad;
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });

  for (const w of [1920, 1440, 1180]) {
    const p = await browser.newPage({ viewport: { width: w, height: 1000 } });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 30000 });
    const bad = await columnsFlush(p);
    const fit = await p.evaluate(() => document.documentElement.dataset.fit);
    check(`at ${w}px every column ends on its band's last line`, fit === "ok" && bad.length === 0, bad.slice(0, 3).join("; ") || `engine says ${fit}`);
    if (w === 1440) {
      // the lead is cut, and its continuation carries on where it stopped
      const jump = await p.evaluate(() => {
        const lead = document.querySelector("#lead .text"), cont = document.querySelector("#from1 .text");
        const lastKept = [...lead.children].filter((c) => c.tagName === "P" && !c.classList.contains("jump")).pop();
        return { jump: !!lead.querySelector(".jump a[href='#from1']"), cont: cont?.children.length || 0, joined: (lastKept?.textContent || "").slice(-30) + " ⟶ " + (cont?.firstElementChild?.textContent || "").slice(0, 30) };
      });
      check("the lead jumps to page 2 and its continuation carries on", jump.jump && jump.cont > 0, jump.joined);
      // a moving picture plays its moment with sound, and the loops hold still meanwhile
      await p.evaluate(() => document.getElementById("ryan").scrollIntoView({ block: "center" }));
      await p.waitForTimeout(900);
      await p.click("#ryan .watch");
      const playing = await until(p, () => window.__eie.Player.yt?.getPlayerState?.() === 1, 20000);
      const t = await p.evaluate(() => window.__eie.Player.yt.getCurrentTime());
      const loops = await p.evaluate(() => [...document.querySelectorAll(".pic video")].every((v) => v.paused));
      check("a moving picture plays its whole story from its start", playing && t > 1360 && t < 1400, `t ${t?.toFixed(1)}`);
      check("while a moment plays, the moving pictures hold still", loops);
      await p.click(".dock-close");
      // an inline moment plays its line
      await p.evaluate(() => document.getElementById("f3").scrollIntoView({ block: "center" }));
      await p.click("#f3 .text .say");
      const t2ok = await until(p, () => { const y = window.__eie.Player.yt; return y?.getPlayerState?.() === 1 && y.getCurrentTime() > 1640 && y.getCurrentTime() < 1660; }, 15000);
      check("a moment in the text plays the line it marks", t2ok);
      await p.click(".dock-close");
      // the quiz's answers turn the right way up
      await p.evaluate(() => document.getElementById("quiz").scrollIntoView({ block: "center" }));
      await p.click("#quiz .answers li:first-child", { position: { x: 30, y: 8 } });
      await p.mouse.move(5, 5);   // away, so the turn is the click's and not the pointer's
      await p.waitForTimeout(800);
      const up = await p.evaluate(() => getComputedStyle(document.querySelector("#quiz .answers")).transform);
      check("the quiz answers turn the right way up when pressed", up === "none" || up === "matrix(1, 0, 0, 1, 0, 0)", up);
    }
    await p.close();
  }
  // the crossword: a correct answer is marked solved and its mark plays the moment; Check flags
  // only the wrong letters; progress survives a reload
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 30000 });
    await p.evaluate(() => localStorage.removeItem("eie.cw.45"));
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 30000 });
    await p.evaluate(() => document.getElementById("crossword").scrollIntoView());
    await p.click('.cw-clue[data-k="17a"]');
    await p.keyboard.type("NILE", { delay: 30 });
    await p.click('.cw-clue[data-k="7a"]');
    await p.keyboard.type("ZEROSUN", { delay: 30 });
    await p.click(".cw-btn:has-text('Check')");
    const s = await p.evaluate(() => ({
      solved: [...document.querySelectorAll(".cw-clue.solved")].map((c) => c.dataset.k),
      wrong: [...document.querySelectorAll(".cw-cell.wrong input")].map((i) => i.value).join(""),
      markShown: getComputedStyle(document.querySelector('.cw-clue[data-k="17a"] .say')).visibility,
      markHidden: getComputedStyle(document.querySelector('.cw-clue[data-k="7a"] .say')).visibility,
    }));
    check("a solved clue shows its mark, and an unsolved one hides it", s.solved.join() === "17a" && s.markShown === "visible" && s.markHidden === "hidden", JSON.stringify(s));
    check("Check flags only the wrong letter", s.wrong === "N", `flagged: ${s.wrong}`);
    await p.click('.cw-clue[data-k="17a"] .say');
    const ok = await until(p, () => { const y = window.__eie.Player.yt; return y?.getPlayerState?.() === 1 && Math.abs(y.getCurrentTime() - 1820.5) < 4; }, 20000);
    check("a solved clue's mark plays the moment its answer came up", ok);
    await p.click(".dock-close");
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 30000 });
    const kept = await p.evaluate(() => [...document.querySelectorAll(".cw-clue.solved")].map((c) => c.dataset.k).join());
    check("crossword progress survives a reload", kept === "17a", kept);
    await p.evaluate(() => localStorage.removeItem("eie.cw.45"));
    await p.close();
  }

  // a phone reads the paper story by story, with the whole lead and no continuation
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached", timeout: 30000 });
    const r = await p.evaluate(() => ({ article: document.documentElement.classList.contains("article"), cont: getComputedStyle(document.getElementById("from1")).display,
      wide: document.documentElement.scrollWidth, last: document.querySelector("#lead .text p:last-child")?.textContent.slice(0, 40) }));
    check("on a phone the lead runs whole, with no jump and nothing wider than the screen", r.article && r.cont === "none" && r.wide <= 390, JSON.stringify(r));
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
