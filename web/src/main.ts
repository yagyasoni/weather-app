import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { ATTRIBUTION, BASEMAP_STYLE, STALE_AFTER_HOURS } from './config'
import { FrameStore, loadLatest, type Loaded } from './data'
import { computeFirstRain, type FirstRain } from './firstrain'
import { lonLatToPixel, wrapLon } from './geo'
import { buildLayers, type LayerDef } from './layers'
import { WET_MM, type SeriesPoint } from './narrative'
import { watchForNewRun } from './newrun'
import { createMap, RainOverlay } from './overlay'
import { PointPanel } from './point'
import { readState, writeState, type ViewState } from './state'
import { Timeline } from './timeline'
import { notify } from './ui'
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

/** Publish a panel's height as a CSS variable so the layout can flow around it. */
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

  /** Records what the map is showing; read by the browser tests. */
  const setShown = (name: string) => (document.body.dataset.shown = name)

  const runWatcher = watchForNewRun(root, manifest.run_id)
  const onLoadError = (err: unknown) => {
    console.warn('forecast data failed to load:', err)
    notify('Could not load forecast data. Check your connection and try again.')
    // the usual cause on a long-open page: a deploy replaced this run's files
    void runWatcher.check({ reloadIfNewer: true })
  }

  await mapReady
  const overlay = new RainOverlay(map, width, height, bounds)
  overlay.add()

  const timeline = new Timeline(frames, async (i) => {
    const target = layer
    const grey = await store.grey(frames[i].file)
    if (layer !== target || layer.kind !== 'animated') return // the layer changed while this frame loaded
    overlay.show(grey, layer.lut)
    setShown(frames[i].file)
  })
  timeline.onError = onLoadError
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
      if (layer.kind !== 'animated') selectLayer('interval')
      timeline.pause()
      void timeline.setIndex(i)
    },
  })
  timeline.onChange = (i) => {
    panel.setCurrent(i)
    persist()
  }

  // "Time until rain" is relative to now, so it is recomputed when it gets old
  let firstRain: { at: number; value: FirstRain } | null = null
  async function getFirstRain(): Promise<FirstRain> {
    const now = Date.now()
    if (!firstRain || now - firstRain.at > 10 * 60_000) {
      firstRain = { at: now, value: await computeFirstRain(store, frames, interval.encoding.vmax, WET_MM, now) }
    }
    return firstRain.value
  }

  let applyToken = 0
  /** Show the selected layer. A newer call wins: a slow load never paints over a later choice. */
  async function applyLayer(): Promise<void> {
    const token = ++applyToken
    const target = layer
    renderLegend(target)
    if (target.kind === 'animated') {
      timeline.setMode('animated') // re-renders the current frame through the timeline
      return
    }
    try {
      timeline.setMode('static', target.kind === 'computed' ? { title: target.readout!.title, sub: 'Working it out…' } : target.readout)
      let grey: Uint8Array
      let lut = target.lut
      if (target.kind === 'computed') {
        const result = await getFirstRain()
        grey = result.grey
        lut = target.lutFor!(result.hours)
      } else {
        grey = await store.grey(target.file!)
      }
      if (token !== applyToken) return
      overlay.show(grey, lut)
      timeline.setMode('static', target.readout)
      setShown(target.file ?? target.id)
    } catch (err) {
      if (token === applyToken) onLoadError(err)
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

  async function selectPoint(lat: number, rawLon: number): Promise<void> {
    const lon = wrapLon(rawLon) // clicks on a repeated copy of the world report e.g. 538°
    const isCurrent = () => point !== null && point.lat === lat && point.lon === lon
    point = { lat, lon }
    overlay.setMarker(lon, lat)
    panel.setLoading(lat, lon)
    persist()
    const { x, y } = lonLatToPixel(lon, lat, width, height)
    let greys: number[]
    try {
      greys = await store.seriesAt(frames.map((f) => f.file), x, y)
    } catch (err) {
      if (isCurrent()) {
        panel.setError(lat, lon, () => void selectPoint(lat, lon))
        onLoadError(err)
      }
      return
    }
    if (!isCurrent()) return // superseded by a newer click
    const series: SeriesPoint[] = frames.map((f, i) => {
      const end = new Date(f.valid_time)
      return { start: new Date(end.getTime() - f.interval_hours * 3600_000), end, mm: decodeMm(greys[i], interval.encoding.vmax) }
    })
    panel.setSeries(lat, lon, series)
  }

  renderLayerChips(layers, layer.id, selectLayer)
  overlay.onClick((lngLat) => void selectPoint(lngLat.lat, lngLat.lng))
  // crossing the breakpoint: collapse the header behind an open sheet, expand it on wide screens
  narrowScreen.addEventListener('change', (e) => collapseHeader(e.matches && panel.visible))

  const first = state.step !== null ? Math.max(0, frames.findIndex((f) => f.step === state.step)) : startIndex(frames)
  await timeline.setIndex(first)
  await applyLayer()
  store.preload(frames.map((f) => f.file), first)
  if (state.point) void selectPoint(state.point.lat, state.point.lon)
}

main().catch(showError)
