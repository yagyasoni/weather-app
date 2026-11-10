import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sample = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/sample/latest.json', import.meta.url)), 'utf8'))
// View the sample 9 hours into its run, whatever today's date is: frame 0 is past, frame 1 is "now".
const NOW = new Date(new Date(sample.run).getTime() + 9 * 3600_000)

const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#111' } }] }

async function open(page: Page, hash = ''): Promise<void> {
  await page.clock.setFixedTime(NOW)
  // no external basemap: tests must not depend on a tile server
  await page.route('https://basemaps.cartocdn.com/**', (route) => route.fulfill({ json: BLANK_STYLE }))
  await page.goto(`./${hash}`)
  await expect.poll(() => shown(page)).toMatch(/^tp_/)
}

const shown = (page: Page) => page.evaluate(() => document.body.dataset.shown ?? '')
const sliderValue = (page: Page) => page.evaluate(() => Number((document.getElementById('slider') as HTMLInputElement).value))

async function setFrame(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const slider = document.getElementById('slider') as HTMLInputElement
    slider.value = String(i)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  }, index)
}

/** Fail every request for one file until the returned function is called. */
async function breakFile(page: Page, file: string): Promise<() => void> {
  let broken = true
  await page.route(`**/${file}`, (route) => (broken ? route.abort() : route.continue()))
  return () => (broken = false)
}

test('starts on the frame that covers now', async ({ page }) => {
  await open(page)
  expect(await sliderValue(page)).toBe(1)
  await expect(page.locator('#lead')).toHaveText('Forecast hour +12')
})

test('a frame that fails to load does not freeze the map, and is retried later', async ({ page }) => {
  const repair = await breakFile(page, 'tp_120.png')
  await open(page)

  await setFrame(page, 19) // step 120: fails
  await expect(page.locator('#toast')).toContainText('Could not load forecast data')
  expect(await shown(page)).not.toBe('tp_120.png')

  await setFrame(page, 20) // the next frame must still render
  await expect.poll(() => shown(page)).toBe('tp_126.png')

  repair()
  await setFrame(page, 19) // and the failed one must be fetched again, not served from a cached error
  await expect.poll(() => shown(page)).toBe('tp_120.png')
})

test('a failed location query shows an error with a working retry', async ({ page }) => {
  const repair = await breakFile(page, 'tp_120.png')
  await open(page)

  await page.mouse.click(900, 420)
  await expect(page.locator('#point-summary')).toContainText('Could not load the outlook')
  await expect(page.locator('.bar')).toHaveCount(0)

  repair()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.bar')).toHaveCount(60)
  await expect(page.locator('#point-summary')).not.toContainText('Could not load')
})

test('offers to load a newer forecast run when one is published', async ({ page }) => {
  await open(page)
  await page.route('**/data/sample/latest.json*', (route) => route.fulfill({ json: { ...sample, run_id: '2099010100' } }))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('#toast')).toContainText('newer forecast run')
  await expect(page.getByRole('button', { name: 'Load it' })).toBeVisible()
})

test('reloads onto the newer run when the old run\'s files have gone', async ({ page }) => {
  await open(page, '#layer=interval&t=12')
  // a deploy happened: the next look at latest.json names a new run, and old files fail
  let first = true
  await page.route('**/data/sample/latest.json*', (route) => {
    if (!first) return route.continue()
    first = false
    return route.fulfill({ json: { ...sample, run_id: '2099010100' } })
  })
  await page.route('**/acc_072.png', (route) => route.abort())
  await page.evaluate(() => ((window as any).__beforeReload = true))

  await page.locator('.chip', { hasText: '3 days' }).click()

  await expect.poll(() => page.evaluate(() => (window as any).__beforeReload === undefined)).toBe(true)
  expect(page.url()).not.toContain('t=12') // the old run's time step is dropped
  expect(page.url()).toContain('layer=acc72')
})

test('switching layers quickly never paints a late image over the newer choice', async ({ page }) => {
  await page.route('**/acc_024.png', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await open(page)

  await page.locator('.chip', { hasText: '1 day' }).click()
  await page.locator('.chip', { hasText: '6-hourly' }).click()
  await page.waitForTimeout(2500) // the slow accumulation image has arrived by now

  expect(await shown(page)).toMatch(/^tp_/)
  await expect(page.locator('#legend-title')).toHaveText('Rain in 6 h, mm')
  await expect(page.locator('.timeline')).not.toHaveClass(/static/)
})

test('time until rain is computed from now', async ({ page }) => {
  await open(page)
  await page.locator('.chip', { hasText: 'Time to rain' }).click()
  await expect.poll(() => shown(page), { timeout: 30_000 }).toBe('first_rain')
  await expect(page.locator('#legend-title')).toHaveText('Time until rain, from now')
  await expect(page.locator('#legend-labels span').first()).toHaveText('now')
  await expect(page.locator('#lead')).toContainText('from now')
})

test('space pauses playback when the play button has focus', async ({ page }) => {
  await open(page)
  const play = page.locator('#play')
  await play.click() // leaves focus on the button
  await expect(play).toHaveClass(/playing/)
  await page.keyboard.press('Space')
  await expect(play).not.toHaveClass(/playing/)

  await page.locator('#map').focus().catch(() => {})
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Space') // and still works as a page-wide shortcut
  await expect(play).toHaveClass(/playing/)
})

test('a click on a repeated copy of the world reports a real longitude', async ({ page }) => {
  await open(page, '#layer=interval&lat=-17.70&lon=538.00')
  await expect(page.locator('#point-title')).toHaveText('17.70°S, 178.00°E')
  await expect(page.locator('.bar')).toHaveCount(60)
  await expect.poll(() => page.url()).toContain('lon=178.00')
})
