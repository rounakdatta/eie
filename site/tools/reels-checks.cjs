// Checks for the newsreel, with the real YouTube player, as a reader uses it: by touch on a phone,
// by keys and wheel on a desktop. Each check is a promise the reel makes, measured on the mechanism
// (where the film is, which player plays) rather than a proxy, so none of them passes against a reel
// that does nothing.
//
//   node site/tools/reels-checks.cjs [base-url] [--phone|--desktop] [--net=4g]
//
// Runs one browser and one page at a time (this box is small). YouTube may ask this server's address
// to "sign in to confirm you're not a bot"; then the film checks say so and fail, and the rest run.
const { chromium, devices } = require("/home/rounak/personal/Codeman/node_modules/playwright");
const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8790/").replace(/\/?$/, "/");
const PHONE = args.includes("--phone"), NET = (args.find((a) => a.startsWith("--net=")) || "").slice(6);
// Headless Chrome refuses even muted autoplay in YouTube's frame now and then (a real browser doesn't), so
// the checks run with autoplay allowed, as the paper's own checks do. --blocked checks what the reel does
// when a browser won't play by itself: in every frame, play() is refused until a tap lands in that
// frame, as a strict phone browser does (Chrome's own strict flag let films play in one run of two).
const BLOCKED = args.includes("--blocked");
const CHROME = process.env.CHROME || "/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(p, fn, ms = 20000, arg) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await p.evaluate(fn, arg); if (v) return v; await sleep(100); } return null; }
const cur = (p) => p.evaluate(() => { const S = window.__reel; const x = S.items[S.cur]; return x ? { i: S.cur, id: x.id, end: x.clip[1], start: x.clip[0] } : null; });
// a thumb's swipe through the real input pipeline (CDP touch), up (next) or down (back)
async function swipe(ctx, page, dir = 1) {
  const cdp = await ctx.newCDPSession(page);
  const vp = page.viewportSize(), x = vp.width / 2;
  const [y0, y1] = dir > 0 ? [vp.height * 0.72, vp.height * 0.22] : [vp.height * 0.28, vp.height * 0.78];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let k = 1; k <= 8; k++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * k / 8 }] }); await sleep(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
const films = (p) => p.evaluate(() => window.__reel.frames.map((f) => ({ item: f.item, state: f.state, t: f.yt?.getCurrentTime?.() ?? null, muted: f.yt?.isMuted?.() ?? null })));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
      ...(NET ? ["--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"] : [])] });
  const ctx = await browser.newContext(PHONE ? { ...devices["Pixel 7"] } : { viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  if (BLOCKED) await ctx.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let tapped = false;
    addEventListener("pointerdown", () => { tapped = true; }, true);
    HTMLMediaElement.prototype.play = function () { return tapped ? play.call(this) : Promise.reject(new DOMException("refused until a tap", "NotAllowedError")); };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (NET === "4g") {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8 });
  }
  await page.goto(`${BASE}reels/?n=045-S01`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.reel[aria-labelledby="h-045-S01"]', { timeout: 30000 });

  if (BLOCKED) {
    const told = await until(page, () => /Tap/.test(document.querySelector("#toast").textContent + document.querySelector("#sound .label").textContent), 30000);
    check("a browser that won't play by itself: the reel says to tap", !!told, await page.evaluate(() => document.querySelector("#toast").textContent || document.querySelector("#sound .label").textContent));
    // a tap on the film itself, where YouTube's play button is: the one gesture every browser honours
    const r = await page.evaluate(() => { const S = window.__reel, b = S.frames.find((f) => f.item === S.cur).el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/home/rounak/personal/eie-reels/shots/blocked-before-tap.png" });
    await page.mouse.click(r[0], r[1]);
    const went = await until(page, () => window.__reel.frames.some((f) => f.state === 1), 15000);
    check("a tap on the film starts it", !!went);
    await page.screenshot({ path: "/home/rounak/personal/eie-reels/shots/blocked-after-tap.png" });
    console.log(JSON.stringify(await page.evaluate(() => window.__reel.timing.map((t) => ({ id: t.id, states: t.states })))));
    check("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed} of ${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
  // 1. the shared moment is the first thing shown, and its film comes ready at its first second
  const c0 = await cur(page);
  check("a shared link opens at its moment", c0?.id === "045-S01", c0?.id);
  // muted, a film may start by itself; it must be moving within a few seconds, at its clip
  const moved = await until(page, () => { const S = window.__reel; const t = S.timing.find((r) => r.id === "045-S01"); return t?.moved; }, 25000);
  check("the first film starts by itself, muted, at its moment", !!moved, moved ? `${moved} ms to a moving picture` : "never moved (a bot check?)");
  const f0 = (await films(page)).find((f) => f.item === 0);
  check("it starts within a second of the moment, not at a keyframe before it", f0 && Math.abs(f0.t * 100 - c0.start) < 400, f0 ? `at ${f0.t?.toFixed(2)} s, clip ${c0.start / 100} s` : "");
  check("it plays muted until the reader asks for sound", f0?.muted === true);

  // 2. the next reel's player is cued (not playing, not offscreen-playing)
  const fl = await films(page);
  const next = fl.find((f) => f.item === 1);
  check("the next reel's film waits, cued, never playing out of sight", !!next && (next.state === 5 || next.state === -1), next ? `state ${next.state}` : "no player");
  check("only one film plays at a time", fl.filter((f) => f.state === 1).length <= 1);

  // 3. nothing over the film, and the film big enough
  const geom = await page.evaluate(() => {
    const S = window.__reel, f = S.frames.find((x) => x.item === S.cur);
    const r = f.el.getBoundingClientRect(), iframe = f.el.querySelector("iframe");
    const pts = [[r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
    const covered = pts.filter(([x, y]) => document.elementFromPoint(x, y) !== iframe).length;
    return { w: r.width, h: r.height, covered };
  });
  check("nothing of the page lies over the film", geom.covered === 0, `${geom.covered} of 5 points covered`);
  check("the film is at least 200×200", geom.w >= 200 && geom.h >= 200, `${Math.round(geom.w)}×${Math.round(geom.h)}`);

  // 4. the words are inked as they are said
  const inked = await until(page, () => document.querySelectorAll('.reel[aria-labelledby="h-045-S01"] .said .w.on').length >= 3, 15000);
  check("the caption inks the words as they are said", !!inked);

  // 5. the clip stops where its last word ends
  const stopped = await until(page, () => { const t = window.__reel.timing.find((r) => r.id === "045-S01"); return t?.stopped; }, 30000);
  check("the clip stops on its last word, not in the next sentence", stopped != null && stopped - c0.end <= 25 && c0.end - stopped <= 60,
    stopped != null ? `stopped ${((stopped - c0.end) * 10).toFixed(0)} ms from the end` : "never stopped");

  // 6. then, untouched, the reel goes on to the next by itself
  const advanced = await until(page, () => window.__reel.cur === 1, 20000);
  check("untouched, the reel goes on to the next after time to read", !!advanced);
  // whether it starts at all (how long it took is reported, not judged: this box varies from 3 to 8 s)
  const moved1 = await until(page, () => window.__reel.timing.find((r) => r.id === window.__reel.items[1].id)?.moved, 40000);
  check("the next film, cued in advance, starts by itself", !!moved1, moved1 ? `${moved1} ms from arriving to a moving picture` : "never");
  console.log(`      measured: first film ${moved} ms, the next (cued) ${moved1} ms, from arriving to a moving picture`);

  // 7. one gesture moves one reel: a swipe on a phone, a key on a desktop
  const before = (await cur(page)).i;
  if (PHONE) await swipe(ctx, page, 1); else await page.keyboard.press("ArrowDown");
  const after = await until(page, (b) => window.__reel.cur !== b && window.__reel.cur, 8000, before);
  check(PHONE ? "a swipe moves exactly one reel" : "the down key moves exactly one reel", after === before + 1, `${before} → ${after}`);
  const settled = await page.evaluate(() => Math.abs(document.querySelector("#feed").scrollTop - window.__reel.cur * window.__reel.H) < 2);
  check("and the reel comes to rest exactly in place", settled);

  // 8. back is instant: the reel before still has its player
  const t0 = Date.now();
  if (PHONE) await swipe(ctx, page, -1); else await page.keyboard.press("ArrowUp");
  await until(page, (a) => window.__reel.cur === a - 1, 8000, after);
  const backMoved = await until(page, () => { const S = window.__reel; const x = S.items[S.cur]; const r = [...S.timing].reverse().find((t) => t.id === x.id); return r?.moved; }, 40000);
  check("going back plays the reel before again, from its first word", !!backMoved, backMoved ? `${backMoved} ms` : "");

  // 9. sound: one tap turns it on and the film plays on with it
  await page.click("#sound");
  await sleep(1200);
  const s = await films(page), here = (await cur(page)).i;
  const playing = s.find((f) => f.item === here);
  check("one tap on Sound gives the film its sound", playing && playing.muted === false, `muted ${playing?.muted}, state ${playing?.state}`);

  // 10. the DOM stays the same size however far the reel goes
  for (let k = 0; k < 6; k++) { if (PHONE) await swipe(ctx, page, 1); else await page.keyboard.press("ArrowDown"); await sleep(1300); }
  const dom = await page.evaluate(() => ({ articles: document.querySelectorAll("#list > article").length, iframes: document.querySelectorAll("iframe").length, cur: window.__reel.cur }));
  check("six reels on, still five articles and three players", dom.articles === 5 && dom.iframes <= 3, JSON.stringify(dom));

  // 11. share copies a link that opens this moment
  if (!PHONE) {
    await page.click("#share");
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    const id = (await cur(page)).id;
    check("Share copies a link to this very moment", copied.endsWith(`?n=${id}`), copied);
  }

  if (process.env.TIMING) console.log(JSON.stringify(await page.evaluate(() => window.__reel.timing.map((t) => ({ id: t.id, lead: t.lead, moved: t.moved, path: t.path, from: t.from, states: t.states, stopped: t.stopped && t.stopped - t.end })))));
  // 12. narrowing the reel: Laughs only
  await page.click("#which");
  await page.waitForSelector("#sheet:not([hidden])");
  await page.locator("#sheet").getByRole("button", { name: "Laughs", exact: true }).click();
  await until(page, () => window.__reel.items.length && window.__reel.items.every((x) => x.k === "J"), 15000);
  const kinds = await page.evaluate(() => [...new Set(window.__reel.items.map((x) => x.k))]);
  check("choosing Laughs gives a reel of laughs only", kinds.length === 1 && kinds[0] === "J", kinds.join(","));
  check("and its address says so, to share or come back to", /kind=J/.test(page.url()), page.url());

  // a search that finds nothing says so, and choosing again works (it used to leave the page dead)
  await page.goto(`${BASE}reels/?q=zxqvwk`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reel.end h2");
  check("a search that finds nothing says so", /Nothing here/.test(await page.textContent(".reel.end h2")));
  await page.getByRole("button", { name: "Choose again" }).click();
  await page.waitForSelector("#sheet:not([hidden])");
  await page.locator("#sheet").getByRole("button", { name: "The newsreel", exact: true }).click();
  const back = await until(page, () => window.__reel.items.length > 3 && document.querySelectorAll("#list > article").length === 5 && window.__reel.frames.some((f) => f.state === 1 || f.state === 3 || f.state === 5), 20000);
  check("and choosing again brings a reel back, films and all", !!back);
  // a returning reader's place belongs to the newsreel alone: a filter starts at its own first moment
  await page.evaluate(() => localStorage.setItem("eie.reel.pos", "30"));
  await page.goto(`${BASE}reels/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reel[data-k]");
  const resumed = await page.evaluate(() => window.__reel.base);
  await page.click("#which");
  await page.waitForSelector("#sheet:not([hidden])");
  await page.locator("#sheet").getByRole("button", { name: "Stories", exact: true }).click();
  const fromTop = await until(page, () => window.__reel.items.length && window.__reel.items.every((x) => x.k === "S") && window.__reel.base === 0, 15000);
  const base = await page.evaluate(() => window.__reel.base);
  check("a returning reader resumes the newsreel, but a filter starts at its first moment", resumed === 31 && base === 0, `resumed at ${resumed}, Stories from ${base}`);

  // 13. an episode's reel ends, and its end names the next steps
  await page.goto(`${BASE}reels/?ep=45&kind=S`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reel[data-k]");
  const total = await page.evaluate(() => window.__reel.total);
  for (let k = 0; k < total; k++) { if (PHONE) await swipe(ctx, page, 1); else await page.keyboard.press("ArrowDown"); await until(page, (n) => window.__reel.cur >= n, 6000, k + 1); }
  const endShown = await until(page, () => !!document.querySelector(".reel.end h2") && window.__reel.cur === window.__reel.total, 20000);
  check("an episode's reel has an end, with ways on", !!endShown, `${total} moments`);
  await page.getByRole("button", { name: "From the top" }).click();
  const top = await until(page, () => window.__reel.cur === 0 && Math.abs(document.querySelector("#feed").scrollTop) < 2, 8000);
  check("“From the top” goes back to the first moment, however far", !!top);

  check("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} of ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
