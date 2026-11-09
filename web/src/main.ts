import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { buildLut, LEGEND_TICKS_MM, legendGradientCss, rampPosition } from './colormap'
import { ATTRIBUTION, BASEMAP_STYLE, STALE_AFTER_HOURS } from './config'
import { FrameStore, loadLatest, type Loaded } from './data'
import { createMap, RainOverlay } from './overlay'
import { Timeline } from './timeline'

const utcFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
})

function modelLabel(model: string): string {
  if (model === 'aifs-single') return 'ECMWF AIFS Single'
  if (model === 'ifs') return 'ECMWF IFS'
  return `ECMWF ${model}`
}

function renderHeader({ manifest, usingFallback }: Loaded): void {
  const run = new Date(manifest.run)
  const generated = new Date(manifest.generated_at)
  document.getElementById('run-info')!.textContent =
    `${modelLabel(manifest.model)} · run ${utcFmt.format(run)} UTC · processed ${utcFmt.format(generated)} UTC`

  const ageHours = (Date.now() - run.getTime()) / 3600_000
  const stale = document.getElementById('stale')!
  if (ageHours > STALE_AFTER_HOURS) {
    stale.textContent = `This forecast run is ${Math.round(ageHours)} h old`
    stale.hidden = false
  }
  document.getElementById('fallback')!.hidden = !usingFallback
}

function renderLegend(): void {
  document.getElementById('legend-bar')!.style.background = legendGradientCss()
  const labels = document.getElementById('legend-labels')!
  labels.replaceChildren()
  for (const mm of LEGEND_TICKS_MM) {
    const span = document.createElement('span')
    span.style.left = `${rampPosition(mm) * 100}%`
    span.textContent = mm >= 50 ? `${mm}+` : String(mm)
    labels.appendChild(span)
  }
}

/** First frame whose interval has not fully passed, so the viewer lands on "now". */
function startIndex(frames: { valid_time: string }[]): number {
  const now = Date.now()
  const i = frames.findIndex((f) => new Date(f.valid_time).getTime() > now)
  return i < 0 ? 0 : i
}

function showError(err: unknown): void {
  console.error(err)
  const info = document.getElementById('run-info')!
  info.textContent = `Could not load the forecast: ${err instanceof Error ? err.message : String(err)}`
  info.classList.add('error')
}

/** Publish the timeline panel's height so CSS can keep map controls clear of it. */
function trackTimelineHeight(): void {
  const panel = document.querySelector<HTMLElement>('.timeline')
  if (!panel) return
  const update = () => document.documentElement.style.setProperty('--timeline-h', `${panel.offsetHeight}px`)
  new ResizeObserver(update).observe(panel)
  update()
}

async function main(): Promise<void> {
  trackTimelineHeight()
  const map = createMap('map', BASEMAP_STYLE, ATTRIBUTION)
  const mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()))

  const data = await loadLatest()
  const { manifest, root } = data
  const layer = manifest.layers.interval
  const { width, height, bounds } = manifest.image

  renderHeader(data)
  renderLegend()

  const runUrl = `${import.meta.env.BASE_URL}${root}/${manifest.run_id}`
  const store = new FrameStore(runUrl, layer.frames, width, height, layer.encoding.vmax)
  const lut = buildLut(layer.encoding.vmax)

  await mapReady
  const overlay = new RainOverlay(map, width, height, bounds, lut)
  overlay.add()

  const timeline = new Timeline(layer.frames, async (i) => overlay.show(await store.grey(i)))
  store.onProgress = (n, total) => timeline.setProgress(n, total)

  const first = startIndex(layer.frames)
  await timeline.setIndex(first)
  store.preloadAll(first)
}

main().catch(showError)
