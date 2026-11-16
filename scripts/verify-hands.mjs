// scripts/verify-hands.mjs
// Hand-tracking end-to-end pass inside the IWER emulator:
//   1. Switch the emulator to hand input mode (no gamepads — pinch select).
//   2. Enter XR, probe the session input sources + per-side ray pointers and
//      verify the laser + cursor tip dot render for hands.
//   3. Aim the LEFT hand ray at a tray card, pinch (real select press) ->
//      'held'. Re-aim at the solution socket, release -> 'placed'.
// Run: node scripts/verify-hands.mjs   (dev server on :8081)
import { chromium } from 'playwright';

const URL = process.env.RECALL_URL || 'https://localhost:8081/';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
// RECORD=1 node scripts/<this>.mjs  → also saves a WebM video of the run
// (deterministic demo footage for the Devpost video; no OBS needed).
const recordVideo = process.env.RECORD
  ? { recordVideo: { dir: '.verify/videos', size: { width: 1600, height: 900 } } }
  : {};
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, ...recordVideo });
const page = await context.newPage();

if (process.env.RECORD) {
  // Clean demo footage: hide the IWER emulator control overlay (fixed div,
  // shadow-rooted). A per-frame sweep survives the overlay mounting late.
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

// Fresh flags so the first-session cue plays at boot (hook beat).
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-flags');
  req.onsuccess = () => res(true); req.onerror = () => res(true);
  setTimeout(() => res(true), 600);
}));
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};

await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('recall-store');
  req.onsuccess = () => res(true);
  req.onerror = () => res(false);
}));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
const app = await findApp();

for (let i = 0; i < 30; i++) {
  const st = await app.evaluate(() => window.__recall.state());
  if (st.phase === 'rebuild') break;
  await page.waitForTimeout(500);
}
console.log('phase:', await app.evaluate(() => window.__recall.state().phase));

// Enter XR first — the emulator's full device toolbar mounts with a session.
await app.evaluate(() => window.__recall.launch());
await page.waitForTimeout(3000);
const app2 = app;

// Switch the emulator to HAND input mode through its own UI: click the
// "Select input mode" toolbar button, then the "Hands" option in the menu.
const findInShadows = (predicate) => app2.evaluate((fn) => {
  const run = new Function('return ' + fn)();
  const hits = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (run(el)) hits.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return hits.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
}, String(predicate));
const modeBtn = (await findInShadows((el) => el.title === 'Select input mode'))?.[0];
if (!modeBtn) {
  const titles = await app2.evaluate(() => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.title || el.getAttribute?.('aria-label')) {
          out.push(el.title || el.getAttribute('aria-label'));
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return [...new Set(out)].slice(0, 40);
  });
  throw new Error('input-mode button not found; devui titles: ' + titles.join(' | '));
}
await page.mouse.click(modeBtn.x, modeBtn.y);
await page.waitForTimeout(600);
const handsOpt = (await findInShadows((el) => el.textContent?.trim() === 'Hands'))?.[0];
if (!handsOpt) throw new Error('Hands option not found');
await page.mouse.click(handsOpt.x, handsOpt.y);
await page.waitForTimeout(1500);

// ---- Probe: are the input sources hands? Are the ray pointers alive? ----
const probe = () => app2.evaluate(() => {
  const w = window.__recall.interaction().world;
  const xr = w.input?.xr;
  const mp = xr?.multiPointers;
  const session = w.renderer?.xr?.getSession?.();
  const sources = session?.inputSources
    ? [...session.inputSources].map((s) => ({
        handedness: s.handedness,
        isHand: !!s.hand,
        targetRayMode: s.targetRayMode,
      }))
    : null;
  const sideInfo = (side) => {
    const m = mp?.[side];
    if (!m) return null;
    const rayVisual = m.ray?.visual;
    const rayPointer = m.ray?.pointer;
    const dot = rayVisual?.ray?.children?.find?.((c) => c.isSprite);
    return {
      rayMeshVisible: rayVisual?.ray?.visible ?? null,
      rayDisplayMode: rayVisual?.rayDisplayMode ?? null,
      pointerEnabled: rayPointer?.enabled ?? null,
      hasIntersection: !!rayPointer?.getIntersection?.(),
      tipDot: dot ? { visible: dot.visible, inScene: !!dot.parent } : null,
    };
  };
  return { sources, left: sideInfo('left'), right: sideInfo('right') };
});
console.log('XR probe:', JSON.stringify(await probe(), null, 1));

// ---- Aim helpers (devui handles drive the emulated device pose) ----
await app2.evaluate(() => {
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
  await app2.evaluate(([h, p]) => {
    const handles = window.transformHandles;
    if (!handles) throw new Error('devui handles unavailable');
    const handle = handles.get(h);
    window.__aimGlobal(handle, new handle.position.constructor(p[0], p[1], p[2]));
  }, [handedness, [worldPoint.x, worldPoint.y, worldPoint.z]]);
};

const plan = await app2.evaluate(() => {
  const it = window.__recall.interaction();
  const ids = [...it.spawn.cardsByNodeId.keys()].filter(
    (id) => it.getCardState(id) === 'free' && !id.startsWith('distractor-'),
  );
  const id = ids[0];
  const cardObj = it.spawn.cardsByNodeId.get(id).object3D;
  const V = cardObj.position.constructor;
  const wp = new V();
  cardObj.getWorldPosition(wp);
  const socketObj = it.spawn.socketsByIndex.get(it.layout.solution[id]).object3D;
  const sp = new V();
  socketObj.getWorldPosition(sp);
  const round = (v) => ({ x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
  return { id, card: round(wp), socket: round(sp) };
});
console.log('plan:', JSON.stringify(plan));

// ---- Find the select cell of the LEFT device panel ('Trig' or 'Pinch') ----
const findSelectCell = (side) => app2.evaluate((side) => {
  const cells = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const t = el.textContent?.trim();
      if (el.childElementCount === 0 && (t === 'Trig' || t === 'Pinch')) {
        const r = el.getBoundingClientRect();
        cells.push({ el, label: t, half: r.x < window.innerWidth / 2 ? 'left' : 'right' });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const label = cells.find((c) => c.half === side);
  const cellEl = label?.el.parentElement?.children[1];
  if (!cellEl) return null;
  const r = cellEl.getBoundingClientRect();
  return { label: label.label, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, side);

await aim('left', plan.card);
await page.waitForTimeout(500);
const cell = await findSelectCell('left');
console.log('left select cell:', JSON.stringify(cell));
if (!cell) throw new Error('left select cell not found (devui panel changed?)');

await page.mouse.move(cell.x, cell.y);
await page.mouse.down();
await page.waitForTimeout(600);
const held = await app2.evaluate((id) => window.__recall.interaction().getCardState(id), plan.id);
console.log('after pinch press, state:', held);
const heldProbe = await probe();
console.log('held probe (left ray should carry):', JSON.stringify(heldProbe.left));

await aim('left', plan.socket);
await page.waitForTimeout(1200);
await page.mouse.up();
await page.waitForTimeout(1200);
const dropped = await app2.evaluate((id) => window.__recall.interaction().getCardState(id), plan.id);
console.log('after release, state:', dropped);
await page.screenshot({ path: '.verify/hands-placed.png' });

const ok = held === 'held' && dropped === 'placed';
console.log(ok ? 'RESULT: HANDS OK — pinch grab + release placement work' : 'RESULT: HANDS FAIL');
if (!ok) console.log(logs.slice(-12).join('\n'));
await browser.close();
process.exit(ok ? 0 : 1);
