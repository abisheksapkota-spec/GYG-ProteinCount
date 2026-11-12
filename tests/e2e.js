// End-to-end test: real server, three phones (manager, cook A, cook B).
// Start the server first:  DATABASE_URL=sqlite:///./data/e2e.db uvicorn app.main:app --port 8765
// Then run:                BASE_URL=http://127.0.0.1:8765 node tests/e2e.js
const { chromium, devices } = require("playwright");
const path = require("path");
const BASE = process.env.BASE_URL || "http://127.0.0.1:8765";
const SHOTS = process.env.SHOTS;
const assert = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const browser = await chromium.launch();
  const phone = async () => { const ctx = await browser.newContext(devices["iPhone 13"]); const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); return { ctx, p, errs }; };
  const shot = (p, n) => SHOTS && p.screenshot({ path: path.join(SHOTS, n) });

  // --- Manager sets up ---
  const M = await phone();
  await M.p.goto(BASE + "/manager");
  await M.p.fill("#mpw", "store-manager-1"); await M.p.click("button[type=submit]");
  await M.p.click("nav button[data-tab=cooks]");
  for (const [n, pin] of [["Cook A", "1111"], ["Cook B", "2222"]]) {
    await M.p.fill("#nName", n); await M.p.fill("#nPin", pin); await M.p.click("#addCook button[type=submit]");
    await M.p.waitForSelector(`.cook-row:has-text("${n}")`);
  }
  assert(await M.p.locator(".cook-row").count() === 2, "Manager added Cook A and Cook B");
  await M.p.click("nav button[data-tab=weights]");
  await M.p.locator('[data-pi="5"] [data-f=w][data-k=box]').fill("10");
  await M.p.click("[data-act=saveW]");
  await M.p.waitForSelector("text=Weights saved for every phone");
  assert(true, "Manager set avocado box = 10 kg");

  // --- a cook counts and submits ---
  async function count(C, name, pin, chickenPrep, notes) {
    await C.p.goto(BASE + "/");
    await C.p.click(`.cook-btn:has-text("${name}")`);
    await C.p.fill("#pin", "0000");
    await C.p.waitForSelector("#loginErr:has-text('Wrong PIN')");
    await C.p.fill("#pin", pin);
    await C.p.waitForSelector("[data-act=start]");
    await C.p.click("[data-act=start]");
    await C.p.click("[data-act=open][data-pid=chk]");
    await C.p.fill("[data-unit=prep]", String(chickenPrep)); await C.p.fill("[data-unit=box]", "4");
    await C.p.click("[data-act=next]");
    await C.p.fill("[data-unit=prep]", "3"); await C.p.fill("[data-unit=pack]", "4"); await C.p.fill("[data-unit=box]", "3");
    await C.p.click("[data-act=next]"); await C.p.click("[data-act=zero]");           // brisket none
    await C.p.click("[data-act=next]"); await C.p.click("[data-act=zero]");           // rib none
    await C.p.click("[data-act=next]"); await C.p.fill("[data-unit=prep]", "1.5");    // pork 9 kg
    await C.p.click("[data-act=next]"); await C.p.fill("[data-unit=box]", "2");       // avocado 20 kg
    await C.p.click("[data-act=next]");
    await C.p.fill("#countNotes", notes);
    await C.p.click("[data-act=submit]");
  }

  const A = await phone();
  await count(A, "Cook A", "1111", 10, "All good");
  await A.p.waitForSelector("text=Sent. Your manager can see it now.");
  assert(true, "Cook A: report sent");
  await shot(A.p, "e2e-cook-done.png");

  // Cook B loses signal right when submitting
  const B = await phone();
  await count(B, "Cook B", "2222", 8, "Low on chicken");
  // (count() submitted online; do a second count offline to test the queue)
  await B.p.waitForSelector("text=Sent. Your manager can see it now.");
  await B.p.click("[data-act=newCount]"); await B.p.click("[data-act=start]");
  await B.p.click("[data-act=open][data-pid=chk]"); await B.p.fill("[data-unit=prep]", "2");
  await B.p.click("[data-act=home]"); await B.p.click("[data-act=review]");
  await B.ctx.setOffline(true);
  await B.p.click("[data-act=submit]"); await B.p.click("#modalOk");
  await B.p.waitForSelector("text=No signal");
  assert(true, "Cook B offline: report kept on the phone");
  await B.p.reload();  // closing the app while offline must not lose it
  await B.p.click("nav button[data-tab=mine]");
  assert(await B.p.isVisible("text=Waiting to send"), "Cook B: report still waiting after reopening the app");
  await B.ctx.setOffline(false);
  await B.p.evaluate(() => dispatchEvent(new Event("online")));
  await B.p.waitForFunction(() => !document.body.innerText.includes("Waiting to send"), null, { timeout: 15000 });
  assert(true, "Cook B: report sent automatically when signal came back");

  // --- Manager sees everything ---
  await M.p.click("nav button[data-tab=reports]");
  await M.p.waitForSelector(".rep");
  const reps = await M.p.locator(".rep").allInnerTexts();
  assert(reps.length === 3, "Manager sees 3 reports (" + reps.length + ")");
  assert(reps.some(t => t.includes("Cook A") && t.includes("208.00")), "Cook A's report: 208 kg (105 + 74 + 9 + 20)");
  assert(reps.some(t => t.includes("Cook B") && t.includes("193.00")), "Cook B's report: 193 kg (90 + 74 + 9 + 20)");
  assert(await M.p.isVisible(".day-h:has-text('Today')"), "Reports grouped under Today");
  await shot(M.p, "e2e-manager-list.png");
  await M.p.selectOption("#fCook", { label: "Cook A" });
  await M.p.waitForFunction(() => document.querySelectorAll(".rep").length === 1);
  assert(true, "Filter by cook shows only Cook A");
  await M.p.click(".rep");
  await M.p.waitForSelector("text=All good");
  const detail = await M.p.locator("#view").innerText();
  assert(detail.includes("105.00") && detail.includes("74.00"), "Report detail shows per-protein totals");
  await shot(M.p, "e2e-manager-detail.png");

  // Cook sees their own reports
  await A.p.click("nav button[data-tab=mine]");
  await A.p.waitForSelector(".rep");
  assert(await A.p.locator(".rep").count() === 1, "Cook A sees only their own report");

  const errs = [...M.errs, ...A.errs, ...B.errs];
  assert(!errs.length, "No page errors " + errs.join("; "));
  await browser.close();
})();
