import { test } from '@argo-video/cli';
import { showOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, zoomTo, resetCamera } from '@argo-video/cli';
import { cursorHighlight, trackCursor } from '@argo-video/cli';

/** Mark scene + let sift's render settle before overlay injection. */
async function mark(page: any, narration: any, scene: string) {
  narration.mark(scene);
  await page.waitForSelector('.pt-row', { state: 'visible', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

/** Scroll the table container by a given offset. */
async function scroll(page: any, container: any, top: number, smooth = false) {
  await container.evaluate((el: HTMLElement, opts: any) =>
    el.scrollBy({ top: opts.top, behavior: opts.smooth ? 'smooth' : undefined }),
    { top, smooth },
  );
}

/** Drag the mouse horizontally from current position through a range of x-offsets. */
async function dragX(page: any, sx: number, sy: number, from: number, to: number, delayMs: number) {
  const step = from < to ? 1 : -1;
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    await page.mouse.move(sx + i * 7, sy);
    await page.waitForTimeout(delayMs);
  }
}

test('sift-showcase', async ({ page, narration }) => {
  test.setTimeout(180000);

  await page.goto('/?dataset=generated');
  trackCursor(page, narration);
  cursorHighlight(page, { color: '#60a5fa', radius: 18 });

  // Wait for all 100k rows to stream in (odometer uses data-value attr)
  await page.waitForFunction(
    () => document.querySelector('.pt-stat-rows')?.getAttribute('data-value')?.includes('100,000'),
    { timeout: 30000 },
  );
  await page.waitForTimeout(1000);

  const headerRow = page.locator('.pt-header-row');
  const tableContainer = page.locator('.pt-table-container');
  // Column indices match generatedColumnOverrides in src/main.ts:
  // 0:id 1:name 2:location 3:department 4:note 5:status 6:priority 7:score 8:email 9:verified
  const col = (n: number) => headerRow.locator('.pt-th').nth(n);

  await mark(page, narration, 'intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  await mark(page, narration, 'summaries');
  const summaryDur = narration.durationFor('summaries');
  showOverlay(page, 'summaries', summaryDur);
  const beat = Math.floor(summaryDur / 3);
  const summaryColumns = [
    { col: col(3), color: '#60a5fa' },  // Department (categorical)
    { col: col(5), color: '#e879f9' },  // Status (categorical)
    { col: col(6), color: '#22d3ee' },  // Priority (categorical)
  ];
  for (const { col: header, color } of summaryColumns) {
    focusRing(page, header, { color, duration: beat });
    await header.hover();
    await page.waitForTimeout(beat);
  }

  await mark(page, narration, 'scroll-fast');
  showOverlay(page, 'scroll-fast', narration.durationFor('scroll-fast'));
  focusRing(page, page.locator('.pt-stats'), { color: '#60a5fa', duration: 4000 });
  await scroll(page, tableContainer, 8000);
  await page.waitForTimeout(800);
  await scroll(page, tableContainer, 12000);
  await page.waitForTimeout(800);
  await scroll(page, tableContainer, -15000, true);
  await page.waitForTimeout(1800);
  await scroll(page, tableContainer, 20000);
  await page.waitForTimeout(600);
  await scroll(page, tableContainer, -25000, true);
  await page.waitForTimeout(1800);
  await tableContainer.evaluate((el: HTMLElement) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(500);

  await mark(page, narration, 'resize-text');
  const resizeDur = narration.durationFor('resize-text');
  showOverlay(page, 'resize-text', resizeDur);
  const noteHeader = col(4);
  zoomTo(page, tableContainer, {
    narration, scale: 1.4, fadeIn: 800, fadeOut: 800,
    duration: resizeDur, holdMs: Math.floor(resizeDur * 0.7),
  });
  await page.waitForTimeout(800);
  const headerBox = await noteHeader.boundingBox();
  if (headerBox) {
    const sx = headerBox.x + headerBox.width - 3;
    const sy = headerBox.y + headerBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(300);
    await page.mouse.down();
    await dragX(page, sx, sy, 0, 50, 40);     // expand
    await page.waitForTimeout(1200);
    await dragX(page, sx, sy, 50, -30, 35);   // contract past original
    await page.waitForTimeout(1200);
    await dragX(page, sx, sy, -30, 10, 30);   // settle
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
  await resetCamera(page);

  // Sort action before mark so the transition reveals a settled table
  const scoreHeader = col(7);
  await scoreHeader.locator('.pt-th-top').click();
  await mark(page, narration, 'sort');
  const sortDur = narration.durationFor('sort');
  showOverlay(page, 'sort', sortDur);
  spotlight(page, scoreHeader, { duration: 2000, padding: 8 });
  await page.waitForTimeout(sortDur);

  await mark(page, narration, 'brush-filter');
  const brushDur = narration.durationFor('brush-filter');
  showOverlay(page, 'brush-filter', brushDur);
  const box = await scoreHeader.locator('.pt-th-summary').boundingBox();
  if (box) {
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width * 0.2;
    const x1 = box.x + box.width * 0.75;
    await page.waitForTimeout(500);
    await page.mouse.move(x0, y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    for (let s = 0; s <= 30; s++) {
      await page.mouse.move(x0 + (x1 - x0) * (s / 30), y);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(3000);
  }

  await mark(page, narration, 'boolean-filter');
  showOverlay(page, 'boolean-filter', narration.durationFor('boolean-filter'));
  const verifiedHeader = col(9);
  await verifiedHeader.scrollIntoViewIfNeeded();
  focusRing(page, verifiedHeader, { color: '#22d3ee', duration: 2500 });
  await page.waitForTimeout(600);
  await verifiedHeader.locator('.pt-bool-true').click();
  await page.waitForTimeout(3000);

  await mark(page, narration, 'clear');
  const clearDur = narration.durationFor('clear');
  showOverlay(page, 'clear', clearDur);
  focusRing(page, page.locator('.pt-filter-pills'), { color: '#e879f9', duration: 2000 });
  await page.waitForTimeout(600);
  // Each click removes a pill, so .first() always targets the next one
  const pills = page.locator('.pt-filter-pill-x');
  while ((await pills.count()) > 0) {
    await pills.first().click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(Math.max(500, clearDur - 3000));

  await mark(page, narration, 'darkmode');
  const darkDur = narration.durationFor('darkmode', { minMs: 3000 });
  showOverlay(page, 'darkmode', darkDur);
  const toggle = page.locator('#theme-toggle');
  focusRing(page, toggle, { color: '#f59e0b', duration: 1500 });
  await page.waitForTimeout(400);
  await toggle.click();
  await page.waitForTimeout(Math.max(500, darkDur - 1500));

  await mark(page, narration, 'closing');
  showConfetti(page, { emoji: ['📊', '⚡', '🔥'], spread: 'burst', duration: 3000, pieces: 180 });
  showOverlay(page, 'closing', 3000);
  await page.waitForTimeout(3000);
});
