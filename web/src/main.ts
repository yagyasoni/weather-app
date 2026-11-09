import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { ATTRIBUTION, BASEMAP_STYLE, STALE_AFTER_HOURS } from './config'
import { FrameStore, loadLatest, type Loaded } from './data'
import { lonLatToPixel } from './geo'
import { buildLayers, type LayerDef } from './layers'
import type { SeriesPoint } from './narrative'
import { collapseAttribution, createMap, RainOverlay } from './overlay'
import { PointPanel } from './point'
import { readState, writeState, type ViewState } from './state'
import { Timeline } from './timeline'
import { decodeMm, encodeGrey } from './types'

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

function renderLegend(layer: LayerDef): void {
  document.getElementById('legend-title')!.textContent = layer.legendTitle
  document.getElementById('legend-bar')!.style.background = layer.gradient
  const labels = document.getElementById('legend-labels')!
  labels.replaceChildren()
  for (const tick of layer.ticks) {
    const span = document.createElement('span')
    span.style.left = `${tick.position * 100}%`
    span.textContent = tick.label
    labels.appendChild(span)
  }
}

function renderLayerChips(layers: LayerDef[], activeId: string, onChange: (id: string) => void): void {
  const group = document.getElementById('layers')!
  group.replaceChildren()
  for (const layer of layers) {
    const label = document.createElement('label')
    label.className = 'chip'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'layer'
    input.value = layer.id
    input.checked = layer.id === activeId
    input.addEventListener('change', () => onChange(layer.id))
    const text = document.createElement('span')
    text.textContent = layer.label
    label.append(input, text)
    group.appendChild(label)
  }
}

/** Publish panel heights as CSS variables so the layout can flow around them. */
function trackHeight(selector: string, cssVar: string): void {
  const panel = document.querySelector<HTMLElement>(selector)
  if (!panel) return
  const update = () => document.documentElement.style.setProperty(cssVar, `${panel.offsetHeight}px`)
  new ResizeObserver(update).observe(panel)
  update()
}

const narrowScreen = window.matchMedia('(max-width: 720px)')

/** On narrow screens the header collapses to its title row; tapping the title toggles it. */
function setupHeaderToggle(): (collapsed: boolean) => void {
  const header = document.querySelector<HTMLElement>('.brand')!
  const button = document.getElementById('brand-toggle')!
  const set = (collapsed: boolean) => {
    header.classList.toggle('collapsed', collapsed)
    button.setAttribute('aria-expanded', String(!collapsed))
  }
  button.addEventListener('click', () => set(!header.classList.contains('collapsed')))
  return set
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

async function main(): Promise<void> {
  trackHeight('.timeline', '--timeline-h')
  trackHeight('.brand', '--header-h')
  trackHeight('.point', '--point-h')
  const collapseHeader = setupHeaderToggle()

  const map = createMap('map', BASEMAP_STYLE, ATTRIBUTION)
  const mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()))

  const data = await loadLatest()
  const { manifest, root } = data
  const interval = manifest.layers.interval
  const { width, height, bounds } = manifest.image
  const frames = interval.frames

  renderHeader(data)

  const store = new FrameStore(`${import.meta.env.BASE_URL}${root}/${manifest.run_id}`, width, height)
  for (const f of frames) store.expectedMax.set(f.file, encodeGrey(f.max_mm, interval.encoding.vmax))

  const layers = buildLayers(manifest)
  const state: ViewState = readState()
  let layer = layers.find((l) => l.id === state.layer) ?? layers[0]
  let point: { lat: number; lon: number } | null = null

  const persist = () => writeState({ layer: layer.id, step: frames[timeline.index]?.step ?? null, point })

  await mapReady
  const overlay = new RainOverlay(map, width, height, bounds, layer.lut)
  overlay.add()

  const timeline = new Timeline(frames, async (i) => overlay.show(await store.grey(frames[i].file)))
  store.onProgress = (n, total) => timeline.setProgress(n, total)

  const panel = new PointPanel({
    onOpen: () => {
      if (narrowScreen.matches) collapseHeader(true)
    },
    onClose: () => {
      point = null
      overlay.clearMarker()
      persist()
    },
    onSelectFrame: (i) => {
      if (layer.kind === 'static') selectLayer('interval')
      timeline.pause()
      void timeline.setIndex(i)
    },
  })
  timeline.onChange = (i) => {
    panel.setCurrent(i)
    persist()
  }

  async function applyLayer(): Promise<void> {
    renderLegend(layer)
    overlay.setLut(layer.lut)
    if (layer.kind === 'static' && layer.file) {
      timeline.setMode('static', layer.readout)
      overlay.show(await store.grey(layer.file))
    } else {
      timeline.setMode('animated')
    }
  }

  function selectLayer(id: string): void {
    const next = layers.find((l) => l.id === id)
    if (!next || next.id === layer.id) return
    layer = next
    renderLayerChips(layers, layer.id, selectLayer)
    void applyLayer()
    persist()
  }

  async function selectPoint(lat: number, lon: number): Promise<void> {
    point = { lat, lon }
    overlay.setMarker(lon, lat)
    panel.setLoading(lat, lon)
    persist()
    const { x, y } = lonLatToPixel(lon, lat, width, height)
    const greys = await store.seriesAt(frames.map((f) => f.file), x, y)
    if (!point || point.lat !== lat || point.lon !== lon) return // superseded by a newer click
    const series: SeriesPoint[] = frames.map((f, i) => {
      const end = new Date(f.valid_time)
      return { start: new Date(end.getTime() - f.interval_hours * 3600_000), end, mm: decodeMm(greys[i], interval.encoding.vmax) }
    })
    panel.setSeries(lat, lon, series)
  }

  renderLayerChips(layers, layer.id, selectLayer)
  overlay.onClick((lngLat) => void selectPoint(lngLat.lat, lngLat.lng))
  // crossing the breakpoint: collapse the header behind an open sheet, expand it on wide screens
  narrowScreen.addEventListener('change', (e) => {
    collapseHeader(e.matches && panel.visible)
    if (e.matches) collapseAttribution(map)
  })

  const first = state.step !== null ? Math.max(0, frames.findIndex((f) => f.step === state.step)) : startIndex(frames)
  await timeline.setIndex(first)
  await applyLayer()
  store.preload(frames.map((f) => f.file), first)
  if (state.point) void selectPoint(state.point.lat, state.point.lon)
}

main().catch(showError)
