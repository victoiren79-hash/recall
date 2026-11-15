export async function run({ page }) {
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('recall-store');
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return 'progress reset — next load starts at session 1, day 1';
}
