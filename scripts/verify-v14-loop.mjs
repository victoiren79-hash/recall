// v14 verification: the learning loop behaves coherently.
//   1. Next Day walks a deterministic ladder: day 2 = session 2, no mirror,
//      exactly 2 hidden links (which stay visible as a dim skeleton).
//   2. Weak-drill day (day 10, strengths decayed below threshold): cards start
//      in the tray, their links MISSING — and after placing them back
//      (placeAll) the links are REBUILT (ensureLinks) and the cycle completes
//      fully lit. (The "not even connected anymore" bug.)
//   3. Restart wipes everything: day 1, session 1, full strength.
//   4. Completion: summary appears (delayed), all links lit.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  // Transient sandbox DNS hiccups are environment noise, not app errors.
  if (m.type() === 'error' && !m.text().includes('ERR_NAME_NOT_RESOLVED')) errors.push('CONSOLE: ' + m.text().slice(0, 160));
});
await page.goto('https://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
  req.onblocked = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};
const app = await findApp();
for (let i = 0; i < 40; i++) {
  const st = await app.evaluate(() => window.__recall.state());
  if (st.spawned) break;
  await page.waitForTimeout(500);
}

const linkStats = () => app.evaluate(() => {
  const it = window.__recall.interaction();
  const links = [...it.spawn.linksById.values()];
  let hidden = 0;
  for (const e of links) {
    // Component data lives at data.instance[entity.index] (IWSDK internal
    // layout — see interaction.setXRMode's Handle lookup).
    const comp = (e.getComponents() ?? []).find?.((c) => c?.id === 'LinkLine');
    const data = comp?.data?.instance?.[e.index];
    if (data?.hidden) hidden++;
  }
  return { count: links.length, hidden, total: it.pack.links.length };
});

// -- 1. Next Day ladder --
await app.evaluate(() => window.__recall.interaction().hud.onNextDay());
// Wait for the rebuild phase (scramble) so hidden links sit at their ghost.
let phase = '';
for (let i = 0; i < 30; i++) {
  phase = (await app.evaluate(() => window.__recall.state().phase)) || '';
  if (phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
const day2 = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const s = window.__recall.state();
  // Hidden links read via their ghost opacity (0.15 vs 0.26 for visible).
  const ops = [...it.spawn.linksById.values()].map((e) => +e.object3D.material.opacity.toFixed(2));
  return {
    day: s.day,
    sessionNum: s.sessionNum,
    mirrored: it.layout.sockets[0].position.x > 0, // socket 0 is left-side
    hiddenGhostCount: ops.filter((v) => v === 0.15).length,
  };
});
console.log('day 2:', JSON.stringify(day2), '(expect day 2, session 2, not mirrored, 2 hidden ghosts)');

// -- 2. Weak-drill day: 9 more next-days push strengths below the threshold --
for (let i = 0; i < 9; i++) await app.evaluate(() => window.__recall.interaction().hud.onNextDay());
await page.waitForTimeout(1500);
const day10 = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const s = window.__recall.state();
  // getCardState is the interaction system's own accessor (component classes
  // are not reachable from the page context).
  const trayCards = it.pack.nodes
    .filter((n) => !n.fixed)
    .filter((n) => it.getCardState(n.id) === 'free')
    .map((n) => n.id);
  return { day: s.day, sessionNum: s.sessionNum, trayCards, linksBefore: it.spawn.linksById.size };
});
console.log('day 10:', JSON.stringify(day10), '(expect de-escalated rung 1 + weak drill: cards pre-removed in tray, links < total)');
const linksBefore = day10.linksBefore;

// placeAll -> weak cards placed -> ensureLinks rebuilds missing connections
await app.evaluate(() => window.__recall.placeAll());
await page.waitForTimeout(2800); // wave settles (1.6s) + summary fade
const afterPlace = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const links = [...it.spawn.linksById.values()];
  const ops = links.map((e) => +e.object3D.material.opacity.toFixed(2));
  return {
    linksAfter: links.length,
    // Lit opacity scales with link strength (0.35 + 0.65*s) — after 10 days
    // of decay (s ≈ 0.46) the lit floor is ~0.65, not 1.0.
    allLit: ops.every((v) => v >= 0.6),
    minOp: Math.min(...ops),
    phase: window.__recall.state().phase,
  };
});
console.log('after placeAll:', JSON.stringify(afterPlace), '(expect links rebuilt to 8, all lit for their strength, summary)');

// -- 3. Restart wipes the run --
await app.evaluate(() => window.__recall.interaction().hud.onRestart());
await page.waitForTimeout(1500);
const afterRestart = await app.evaluate(() => window.__recall.state());
console.log('after restart:', JSON.stringify(afterRestart), '(expect day 1, session 1)');

console.log('errors:', errors.length === 0 ? 'NONE' : errors.slice(0, 5).join(' | '));
await browser.close();
const pass =
  day2.day === 2 && day2.sessionNum === 2 && !day2.mirrored && day2.hiddenGhostCount === 2 &&
  day10.sessionNum === 1 && day10.trayCards.length > 0 && linksBefore < 8 &&
  afterPlace.linksAfter === 8 && afterPlace.allLit && afterPlace.phase === 'summary' &&
  afterRestart.day === 1 && afterRestart.sessionNum === 1 &&
  errors.length === 0;
console.log(pass ? 'v14 PASS' : 'v14 FAIL');
process.exit(pass ? 0 : 1);
