// scripts/demo-take.mjs
// ONE continuous demo take, played by the robot and recorded automatically.
// Arc (matches the voiceover): fresh day 1 in the normal palette → study cue →
// scramble → two correct placements → one deliberate wrong-order bounce (the
// feedback beat) → remaining placements → completion sequence → summary →
// Next Day → briefing toast → contrast toggle.
// Run: node scripts/demo-take.mjs   (dev server on :8081; video lands in
// .verify/videos — ~10 minutes of wall time. You just wait.)
import { chromium } from 'playwright';

const URL = 'https://localhost:8081/';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: '.verify/videos', size: { width: 1600, height: 900 } },
});
const page = await context.newPage();

if (true) {
  // Clean demo footage: hide the IWER emulator control overlay visually
  // (opacity only — the robot still clicks its buttons underneath).
  await page.addInitScript(() => {
    const sweep = () => {
      for (const d of document.querySelectorAll('div')) {
        if (d.shadowRoot && d.style.position === 'fixed' && d.style.width === '100vw') {
          d.style.opacity = '0';
        }
      }
      requestAnimationFrame(sweep);
    };
    requestAnimationFrame(sweep);
  });
}

// First load compiles the whole app — give it up to 3 × 3 minutes.
const gotoPatient = async (url, what) => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await (what === 'reload' ? page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
                              : page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 }));
      return;
    } catch (err) {
      console.log(`${what} attempt ${attempt} timed out — retrying in 10 s`);
      await page.waitForTimeout(15000);
      if (attempt === 10) throw err;
    }
  }
};
await gotoPatient(URL, 'open');

const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};

// Fresh everything: day 1, normal palette, first-session cue ON.
await page.evaluate(() => new Promise((res) => {
  indexedDB.deleteDatabase('recall-store').onsuccess = () => res(1);
  setTimeout(() => res(1), 800);
}));
await page.evaluate(() => new Promise((res) => {
  indexedDB.deleteDatabase('recall-flags').onsuccess = () => res(1);
  setTimeout(() => res(1), 800);
}));
await gotoPatient(URL, 'reload');
const app = await findApp();

for (let i = 0; i < 40; i++) {
  const st = await app.evaluate(() => window.__recall.state());
  if (st.phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
console.log('phase:', await app.evaluate(() => window.__recall.state().phase));

// Capture-start window: the app is loaded and stable — if you are filming
// this run with Win+Shift+R (Snipping Tool) or Win+Alt+R (Game Bar),
// START YOUR CAPTURE NOW. 25 seconds to get set.
console.log('=======================================================');
console.log('=== APP READY — START YOUR SCREEN CAPTURE NOW (25 s) ===');
console.log('=======================================================');
await page.waitForTimeout(25000);

await app.evaluate(() => window.__recall.launch());
await page.waitForTimeout(3500);

// ---- Robot controls (devui handles drive the emulated devices) ----
await app.evaluate(() => {
  window.__HOLD_DIST = 0.45;
  window.__aimGlobal = (handle, target) => {
    const V = handle.position.constructor;
    const Q = handle.quaternion.constructor;
    const rig = handle.parent;
    const head = rig.getWorldPosition(new V());
    const dir = target.clone().sub(head).normalize();
    const pos = target.clone().addScaledVector(dir, -window.__HOLD_DIST);
    pos.y += 0.02;
    handle.position.copy(rig.worldToLocal(pos.clone()));
    const rigQ = rig.getWorldQuaternion(new Q());
    const localDir = dir.clone().applyQuaternion(rigQ.clone().invert());
    handle.quaternion.copy(new Q().setFromUnitVectors(new V(0, 0, -1), localDir));
    handle.updateMatrixWorld(true);
  };
});
const aim = async (handedness, worldPoint) => {
  await app.evaluate(([h, p]) => {
    const handles = window.transformHandles;
    if (!handles) throw new Error('devui handles unavailable');
    const handle = handles.get(h);
    window.__aimGlobal(handle, new handle.position.constructor(p[0], p[1], p[2]));
  }, [handedness, [worldPoint.x, worldPoint.y, worldPoint.z]]);
};

const findTrigCell = (side) => app.evaluate((side) => {
  const cells = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount === 0 && el.textContent?.trim() === 'Trig') {
        const r = el.getBoundingClientRect();
        cells.push({ el, half: r.x < window.innerWidth / 2 ? 'left' : 'right' });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const label = cells.find((c) => c.half === side);
  const cellEl = label?.el.parentElement?.children[1];
  if (!cellEl) return null;
  const r = cellEl.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, side);
const leftTrig = await findTrigCell('left');
const rightTrig = await findTrigCell('right');
console.log('trig cells:', JSON.stringify({ leftTrig, rightTrig }));

// World positions: tray card / solution socket / HUD button meshes.
const cardWorld = (nodeId) => app.evaluate((id) => {
  const it = window.__recall.interaction();
  const obj = it.spawn.cardsByNodeId.get(id).object3D;
  const V = obj.position.constructor;
  const wp = new V();
  obj.updateWorldMatrix(true, false);
  obj.getWorldPosition(wp);
  return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
}, nodeId);
const socketWorld = (nodeId) => app.evaluate((id) => {
  const it = window.__recall.interaction();
  const V = it.world.scene.position.constructor;
  const idx = it.layout.solution[id];
  const s = it.layout.sockets[idx];
  const rootObj = it.spawn.structure.object3D;
  rootObj.updateWorldMatrix(true, false);
  const wp = new V(s.position.x, s.position.y, s.position.z).applyMatrix4(rootObj.matrixWorld);
  return { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
}, nodeId);
// HUD buttons are width-0.18 (menu column) or 0.13 (summary row) meshes in
// the root frame; pick by y/x bands.
const hudButton = (pred) => app.evaluate((fn) => {
  const run = new Function('return ' + fn)();
  const root = window.__recall.interaction().spawn.root.object3D;
  let target = null;
  root.traverse((o) => {
    if (target || !o.isMesh || !o.geometry?.parameters?.width) return;
    if (!run(o.geometry.parameters.width, o.position)) return;
    const V = o.position.constructor;
    const wp = new V();
    o.getWorldPosition(wp);
    target = { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) };
  });
  return target;
}, String(pred));

const state = (id) => app.evaluate((x) => window.__recall.interaction().getCardState(x), id);

// Grab → carry → release at a world point; returns the card state after.
const grabCarryRelease = async (nodeId, targetWorld, settleMs) => {
  await aim('left', await cardWorld(nodeId));
  await page.waitForTimeout(700);
  await page.mouse.move(leftTrig.x, leftTrig.y);
  await page.mouse.down();
  await page.waitForTimeout(900);
  const held = await state(nodeId);
  if (held !== 'held') {
    await page.mouse.up();
    console.log(`  ${nodeId}: grab FAILED (${held})`);
    return held;
  }
  await aim('left', targetWorld);
  await page.waitForTimeout(1400);
  await page.mouse.up();
  await page.waitForTimeout(settleMs);
  const after = await state(nodeId);
  console.log(`  ${nodeId}: released at target → ${after}`);
  return after;
};

// ---- Beat 1: study (SEE with cue) already played during boot — hold ----
await page.waitForTimeout(4000);

// ---- Beat 2: deliberate wrong-band bounce (feedback beat) ----
// Evaporation into Clouds' socket — wrong height, deterministic amber toast
// ("belongs at a different height"). Band/occupied slips carry no link
// evidence, so the money summary still needs a wrong-order session (see
// verify-v13-summary) — this beat shows the FEEDBACK, not the penalty.
console.log('beat: wrong-band bounce');
{
  const cloudSock = await socketWorld('cloud');
  await grabCarryRelease('evap', cloudSock, 3500);
  await page.waitForTimeout(2500); // extra hold on the toast
}

// ---- Beat 3: correct placements, collect FIRST (fixes the flow) ----
console.log('beat: correct placements');
const order = ['collect', 'evap', 'vapor', 'cooling', 'cond', 'cloud', 'precip'];
for (const id of order) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await state(id)) === 'placed') break;
    const sock = await socketWorld(id);
    const st = await grabCarryRelease(id, sock, 1800);
    if (st === 'placed') break;
    for (let i = 0; i < 8 && (await state(id)) !== 'free'; i++) await page.waitForTimeout(500);
  }
}

// ---- Beat 4: completion sequence — hold, silence ----
console.log('beat: completion hold');
await page.waitForTimeout(9000);

// ---- Beat 5: summary — hold ----
console.log('beat: summary hold');
await page.waitForTimeout(8000);

// ---- Beat 6: press Next Day (summary row), briefing toast ----
console.log('beat: next day + briefing');
const nextDaySummary = await hudButton(
  (w, p) => w === 0.13 && p.x < -0.05 && p.x > -0.15 && p.y < -0.2,
);
console.log('next day button:', JSON.stringify(nextDaySummary));
if (nextDaySummary && rightTrig) {
  await aim('right', nextDaySummary);
  await page.waitForTimeout(500);
  await page.mouse.move(rightTrig.x, rightTrig.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(5000); // briefing toast beat
}

// ---- Beat 7: contrast toggle, hold on the high-contrast view ----
console.log('beat: contrast toggle');
await page.waitForTimeout(4000); // new session fully spawned
const contrastBtn = await hudButton(
  (w, p) => w === 0.18 && p.x < -0.55 && p.y < -0.2 && p.y > -0.3,
);
let contrastDebug = null;
if (!contrastBtn) {
  await page.waitForTimeout(3000);
  contrastDebug = await app.evaluate(() => {
    const out = [];
    const root = window.__recall.interaction().spawn.root.object3D;
    root.traverse((o) => {
      if (o.isMesh && o.geometry?.parameters?.width === 0.18) {
        out.push({ x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2) });
      }
    });
    return { buttons: out, phase: window.__recall.state().phase, day: window.__recall.state().day };
  });
  console.log('contrast retry dump:', JSON.stringify(contrastDebug));
}
console.log('contrast button:', JSON.stringify(contrastBtn));
if (contrastBtn && rightTrig) {
  await aim('right', contrastBtn);
  await page.waitForTimeout(500);
  await page.mouse.move(rightTrig.x, rightTrig.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(5000); // high-contrast view beat
}

console.log('DEMO TAKE COMPLETE — video in .verify/videos');
await browser.close();
