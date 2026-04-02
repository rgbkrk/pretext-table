import { test, expect } from '@playwright/test'

/**
 * Performance benchmarks for the pretext-table engine.
 *
 * These tests measure real-world performance in a headless browser,
 * capturing timing for mount, scroll, resize, sort, and filter operations.
 * Results are logged to stdout for CI visibility.
 *
 * Run with: npx playwright test e2e/perf.spec.ts
 */

function log(label: string, ms: number) {
  const formatted = ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`
  console.log(`  ⏱  ${label.padEnd(40)} ${formatted}`)
}

test.describe('Performance Benchmarks (100k rows)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.pt-table-container')
    // Wait for all 100k rows to stream in
    await expect(page.locator('.pt-stat-rows')).toContainText('100,000', { timeout: 15_000 })
  })

  test('mount and stream all batches', async ({ page }) => {
    // Measure a fresh page load
    const start = Date.now()
    await page.goto('/')
    await page.waitForSelector('.pt-table-container')
    const firstBatch = Date.now() - start

    await expect(page.locator('.pt-stat-rows')).toContainText('100,000', { timeout: 15_000 })
    const allBatches = Date.now() - start

    console.log('\n📊 Mount & Stream Performance (100k rows, 12 columns):')
    log('First batch → table visible', firstBatch)
    log('All 20 batches streamed', allBatches)

    // First batch should render in under 5s (headless Chromium is slower than desktop)
    expect(firstBatch).toBeLessThan(5000)
    // All batches in under 10s
    expect(allBatches).toBeLessThan(10_000)
  })

  test('scroll frame time', async ({ page }) => {
    const viewport = page.locator('.pt-viewport')

    // Warm up: scroll once
    await viewport.evaluate(el => el.scrollTop = 1000)
    await page.waitForTimeout(100)

    // Measure 20 scroll steps (each waits for RAF render)
    const times = await viewport.evaluate(el => {
      return new Promise<number[]>(resolve => {
        const results: number[] = []
        let step = 0
        function tick() {
          const t0 = performance.now()
          el.scrollTop = 2000 + step * 500
          requestAnimationFrame(() => {
            // Measure after the render frame completes
            results.push(performance.now() - t0)
            step++
            if (step < 20) tick()
            else resolve(results)
          })
        }
        tick()
      })
    })

    const avg = times.reduce((a, b) => a + b) / times.length
    const max = Math.max(...times)
    const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)]

    console.log('\n📊 Scroll Performance (20 frames across 10k rows):')
    log('Average frame time', avg)
    log('P95 frame time', p95)
    log('Max frame time', max)

    // Scroll frames should be under 16ms (60fps)
    expect(avg).toBeLessThan(16)
  })

  test('sort response time', async ({ page }) => {
    const scoreTh = page.locator('.pt-th', { hasText: 'SCORE' })

    // Measure sort click → re-render
    const sortTime = await page.evaluate(() => {
      return new Promise<number>(resolve => {
        const th = document.querySelector('.pt-th:nth-child(8)') as HTMLElement // Score
        const t0 = performance.now()
        th.click()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(performance.now() - t0)
          })
        })
      })
    })

    console.log('\n📊 Sort Performance (100k rows):')
    log('Sort click → re-render', sortTime)

    // Sort should complete in under 500ms
    expect(sortTime).toBeLessThan(500)

    // Verify sort actually applied
    await expect(scoreTh.locator('.pt-sort-arrow')).toContainText('↑')
  })

  test('filter response time', async ({ page }) => {
    // Brush the Score histogram to create a range filter
    const scoreTh = page.locator('.pt-th', { hasText: 'SCORE' })
    const summary = scoreTh.locator('.pt-th-summary')
    const box = await summary.boundingBox()
    if (!box) throw new Error('No summary bounding box')

    const filterTime = await page.evaluate(({ x, y, w, h }) => {
      return new Promise<number>(resolve => {
        const svg = document.querySelector('.pt-th:nth-child(8) .pt-th-summary svg:last-child') as SVGElement
        if (!svg) { resolve(-1); return }

        const t0 = performance.now()
        // Simulate brush
        svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: x + 10, clientY: y + h / 2, bubbles: true }))
        svg.dispatchEvent(new PointerEvent('pointermove', { clientX: x + w / 2, clientY: y + h / 2, bubbles: true }))
        svg.dispatchEvent(new PointerEvent('pointerup', { clientX: x + w / 2, clientY: y + h / 2, bubbles: true }))

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(performance.now() - t0)
          })
        })
      })
    }, { x: box.x, y: box.y, w: box.width, h: box.height })

    console.log('\n📊 Filter Performance (100k rows):')
    log('Brush filter → re-render', filterTime)

    // Filter should complete in under 500ms
    if (filterTime > 0) {
      expect(filterTime).toBeLessThan(500)
    }
  })

  test('column resize frame time', async ({ page }) => {
    const nameTh = page.locator('.pt-th').nth(1)
    const handle = nameTh.locator('.pt-resize-handle')
    const handleBox = await handle.boundingBox()
    if (!handleBox) throw new Error('No handle bounding box')

    // Measure resize drag frames
    const resizeTimes = await page.evaluate(({ x, y }) => {
      return new Promise<number[]>(resolve => {
        const handle = document.querySelector('.pt-th:nth-child(2) .pt-resize-handle') as HTMLElement
        if (!handle) { resolve([]); return }

        handle.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: x, clientY: y, pointerId: 1, bubbles: true,
        }))

        const results: number[] = []
        let step = 0
        function tick() {
          const t0 = performance.now()
          handle.dispatchEvent(new PointerEvent('pointermove', {
            clientX: x + step * 5, clientY: y, pointerId: 1, bubbles: true,
          }))
          document.body.offsetHeight // force layout
          results.push(performance.now() - t0)
          step++
          if (step < 20) requestAnimationFrame(tick)
          else {
            handle.dispatchEvent(new PointerEvent('pointerup', {
              clientX: x + 100, clientY: y, pointerId: 1, bubbles: true,
            }))
            resolve(results)
          }
        }
        requestAnimationFrame(tick)
      })
    }, { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 })

    if (resizeTimes.length > 0) {
      const avg = resizeTimes.reduce((a, b) => a + b) / resizeTimes.length
      const max = Math.max(...resizeTimes)

      console.log('\n📊 Column Resize Performance (20 drag frames, 100k rows):')
      log('Average resize frame', avg)
      log('Max resize frame', max)

      // Resize frames should be fast — pretext layout() is ~0.0002ms per cell
      expect(avg).toBeLessThan(16)
    }
  })
})
