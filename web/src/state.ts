/** Shareable view state kept in the URL hash: #layer=interval&t=12&lat=23.5&lon=77.4 */

export interface ViewState {
  layer: string
  step: number | null
  point: { lat: number; lon: number } | null
}

export function readState(): ViewState {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const lat = Number(params.get('lat'))
  const lon = Number(params.get('lon'))
  const step = params.get('t')
  return {
    layer: params.get('layer') ?? 'interval',
    step: step !== null && Number.isFinite(Number(step)) ? Number(step) : null,
    point: Number.isFinite(lat) && Number.isFinite(lon) && params.has('lat') && params.has('lon') ? { lat, lon } : null,
  }
}

let timer: number | undefined
let queued: ViewState | null = null

function write(state: ViewState): void {
  const params = new URLSearchParams()
  params.set('layer', state.layer)
  if (state.step !== null) params.set('t', String(state.step))
  if (state.point) {
    params.set('lat', state.point.lat.toFixed(2))
    params.set('lon', state.point.lon.toFixed(2))
  }
  history.replaceState(null, '', `#${params.toString()}`)
}

/** Write the state without adding history entries; coalesces rapid updates. */
export function writeState(state: ViewState): void {
  queued = state
  window.clearTimeout(timer)
  timer = window.setTimeout(flushState, 150)
}

/** Write any queued state now. Call before leaving the page so the URL is current. */
export function flushState(): void {
  window.clearTimeout(timer)
  if (queued) write(queued)
  queued = null
}
