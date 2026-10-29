// More checks for the newspaper: the fit at nine widths, the jump keeps every word, a resize
// re-sets cleanly, the crossword keys, and nothing wider than a 320px phone.
//
//   node site/tools/paper-verify.cjs
const { chromium } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const URL = "http://127.0.0.1:8746/45/";
const out = [];
const check = (name, ok, detail = "") => { out.push(ok); console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
(async () => {
  const b = await chromium.launch({ executablePath: "/home/rounak/.nix-profile/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  // 1. the fit at many widths, including odd ones
  const widths = [1180, 1199, 1250, 1333, 1366, 1512, 1600, 1728, 2560];
  const bad = [];
  for (const w of widths) {
    const p = await b.newPage({ viewport: { width: w, height: 1000 } });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 120000 });
    const fit = await p.evaluate(() => document.documentElement.dataset.fit);
    if (fit !== "ok") bad.push(`${w}: ${fit}`);
    // 2. the jump loses and repeats nothing: page 1 + page 2 = the edition's lead
    if (w === 1440 || w === 1199 || w === 2560) {
      const r = await p.evaluate(async () => {
        const e = await fetch("edition.json").then((x) => x.json());
        const clean = (s) => s.replace(/[­\u200b]/g, "").replace(/\{[^}]*\}|\[\[[^\]]*\]\]/g, "").replace(/\*/g, "").replace(/^## /, "").replace(/\s+/g, " ").trim();
        const want = clean(`${e.p1.lead.dateline}: ` + e.p1.lead.body.map(clean).join(" "));
        // the words of the copy: not the play marks' hidden time labels, nor the cross-references' "→ No. 66"
        const grab = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.classList.contains("jump")).map((el) => { const c = el.cloneNode(true); c.querySelectorAll(".say, .xr").forEach((x) => x.remove()); return c.textContent; }).join(" ");
        let got = clean(grab("#lead .text > *") + " " + grab("#from1 .text > *"));
        got = got.replace(/(\w)- (\w)/g, "$1$2");   // a word hyphenated across the jump
        return { same: got === want, want: want.length, got: got.length, diff: (() => { let i = 0; while (i < want.length && want[i] === got[i]) i++; return `${want.slice(i, i + 40)} | ${got.slice(i, i + 40)}`; })() };
      });
      check(`at ${w}px the jump to page 2 loses and repeats no words`, r.same, r.same ? `${r.got} characters` : r.diff);
    }
    await p.close();
  }
  check(`every band fits at ${widths.join(", ")}`, bad.length === 0, bad.join("; "));
  // 3. a resize re-sets the paper cleanly, without doubling the continuation
  {
    const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-fit]", { state: "attached", timeout: 120000 });
    const n1 = await p.evaluate(() => document.querySelector("#from1 .text").textContent.length);
    await p.setViewportSize({ width: 1260, height: 1000 });
    await p.waitForTimeout(400);
    await p.waitForFunction(() => document.documentElement.dataset.fit, null, { timeout: 120000 });
    await p.setViewportSize({ width: 1500, height: 1000 });   // and again, while it may still be setting
    await p.waitForTimeout(260);
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.waitForTimeout(400);
    await p.waitForFunction(() => document.documentElement.dataset.fit, null, { timeout: 120000 });
    const r = await p.evaluate(() => ({ fit: document.documentElement.dataset.fit, n: document.querySelector("#from1 .text").textContent.length, pages: document.querySelectorAll(".page").length, leads: document.querySelectorAll("#lead").length }));
    check("resizing re-sets the paper cleanly", r.fit === "ok" && r.n === n1 && r.pages === 4 && r.leads === 1, JSON.stringify({ ...r, before: n1 }));
    // 4. the crossword's keyboard: arrows, Tab, Backspace, Enter
    await p.evaluate(() => { localStorage.removeItem("eie.cw.45"); document.getElementById("crossword").scrollIntoView(); });
    await p.click('.cw-clue[data-k="17a"]');
    await p.keyboard.type("NI", { delay: 20 });
    await p.keyboard.press("Backspace");   // the square after I is empty: back to I, cleared
    const afterBack = await p.evaluate(() => document.activeElement.value + "|" + document.querySelector(".cw-bar").textContent.slice(0, 9));
    await p.keyboard.press("Tab");
    const afterTab = await p.evaluate(() => document.querySelector(".cw-bar").textContent.slice(0, 10));
    await p.keyboard.press("Shift+Tab");
    const afterShiftTab = await p.evaluate(() => document.querySelector(".cw-bar").textContent.slice(0, 10));
    check("Backspace steps back and clears; Tab and Shift+Tab move between clues", afterBack.startsWith("|17 across") && afterTab !== afterShiftTab && afterShiftTab.startsWith("17 across"), `${afterBack} · ${afterTab} · ${afterShiftTab}`);
    // the N of NILE is also the last letter of COMPOSITION (5 down): Enter turns the direction there
    await p.evaluate(() => { const g = document.querySelector(".cw-grid"); const cell = [...g.children].find((c) => c.style.gridRow.startsWith("12") && c.style.gridColumn.startsWith("12")); cell.querySelector("input").focus(); });
    await p.keyboard.press("Enter");
    const turned = await p.evaluate(() => document.querySelector(".cw-bar").textContent.slice(0, 8));
    check("Enter on a crossing square turns to the other direction", turned.startsWith("5 down"), turned);
    await p.evaluate(() => localStorage.removeItem("eie.cw.45"));
    await p.close();
  }
  // 5. a phone: nothing wider than the screen, the crossword's squares fit
  {
    for (const w of [320, 360]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("html[data-ready]", { state: "attached", timeout: 120000 });
    const r = await p.evaluate(() => { const g = document.querySelector(".cw-grid").getBoundingClientRect(); return { wide: document.documentElement.scrollWidth, grid: Math.round(g.right) }; });
    check(`on a ${w}px phone nothing is wider than the screen, the crossword included`, r.wide <= w && r.grid <= w, JSON.stringify(r));
    await ctx.close();
    }
  }
  await b.close();
  const failed = out.filter((x) => !x).length;
  console.log(`${out.length - failed}/${out.length} passed`);
})();
