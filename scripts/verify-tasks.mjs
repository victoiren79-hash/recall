import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
await page.goto('https://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 60000 });
const findApp = async () => {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => Boolean(window.__recall))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no app frame');
};
// Fresh everything
await page.evaluate(() => new Promise((res) => {
  indexedDB.deleteDatabase('recall-store').onsuccess = () => res(1);
  setTimeout(() => res(1), 800);
}));
await page.evaluate(() => new Promise((res) => {
  indexedDB.deleteDatabase('recall-flags').onsuccess = () => res(1);
  setTimeout(() => res(1), 800);
}));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
const app = await findApp();

// --- Task 1: cue visible during SEE on the very first session ---
await page.waitForTimeout(1500);
const cueSeen = await app.evaluate(() => {
  // The cue panel is the only non-toast visible panel at y≈0.4 z −0.62 —
  // simpler: check the flags store got written right after showing.
  return null;
});
await page.waitForTimeout(2500);
const flagsAfterFirst = await app.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('recall-flags', 1);
  req.onsuccess = () => {
    try {
      const get = req.result.transaction('kv', 'readonly').objectStore('kv').get('skipIntro');
      get.onsuccess = () => res({ skipIntro: Boolean(get.result) });
    } catch (e) { res({ err: String(e) }); }
  };
  req.onerror = () => res({ err: 'open failed' });
}));
console.log('flags after first boot:', JSON.stringify(flagsAfterFirst));
await page.screenshot({ path: '.verify/task1-cue.png', timeout: 15000 }).catch(() => console.log('cue screenshot skipped'));

// --- Task 3: geometry/material counts in a typical session ---
const counts = await app.evaluate(() => {
  const scene = window.__recall.scene();
  let meshes = 0;
  let sprites = 0;
  const mats = new Set();
  const geos = new Set();
  scene.traverse((o) => {
    if (!o.visible) return;
    if (o.isSprite) { sprites += 1; if (o.material) mats.add(o.material.uuid); }
    if (o.isMesh && o.geometry) {
      meshes += 1;
      geos.add(o.geometry.uuid);
      const m = Array.isArray(o.material) ? o.material : [o.material];
      for (const mm of m) if (mm) mats.add(mm.uuid);
    }
  });
  return { meshes, sprites, uniqueMaterials: mats.size, uniqueGeometries: geos.size };
});
console.log('scene counts:', JSON.stringify(counts));

// --- Task 2: contrast toggle flips palettes live ---
const before = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const e = [...it.spawn.cardsByNodeId.values()][0];
  const mats = e.cardMats;
  return {
    bodyOpacity: mats.body.opacity,
    faceContrast: mats.faceEntry.contrast,
    socket: it.spawn.sharedMaterials.map((m) => m.uuid).length,
  };
});
await app.evaluate(() => window.__recall.setContrast(true));
await page.waitForTimeout(600);
const after = await app.evaluate(() => {
  const it = window.__recall.interaction();
  const e = [...it.spawn.cardsByNodeId.values()][0];
  const mats = e.cardMats;
  const socketColor = (() => {
    const canvas = mats.face.map.image;
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(canvas.width / 2, canvas.height * 0.2, 1, 1).data;
    return [px[0], px[1], px[2]];
  })();
  return {
    bodyOpacity: mats.body.opacity,
    faceContrast: mats.faceEntry.contrast,
    faceBorderPixel: socketColor,
  };
});
console.log('contrast before:', JSON.stringify(before));
console.log('contrast after :', JSON.stringify(after));
await app.evaluate(() => window.__recall.setContrast(false));
await page.waitForTimeout(400);
const reverted = await app.evaluate(() => window.__recall.interaction().spawn.cardsByNodeId && [...window.__recall.interaction().spawn.cardsByNodeId.values()][0].cardMats.faceEntry.contrast);
console.log('reverted contrast flag:', reverted);

// --- Task 4 + persistence: reload keeps skipIntro (cue never repeats) ---
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 30; i++) {
  const has = await (await findApp()).evaluate(() => Boolean(window.__recall));
  if (has) break;
  await page.waitForTimeout(500);
}
const flagsAfterReload = await app.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('recall-flags', 1);
  req.onsuccess = () => {
    const get = req.result.transaction('kv', 'readonly').objectStore('kv').get('skipIntro');
    get.onsuccess = () => res(Boolean(get.result));
  };
}));
console.log('skipIntro persisted across reload:', flagsAfterReload);
await browser.close();
console.log('VERIFY DONE');
