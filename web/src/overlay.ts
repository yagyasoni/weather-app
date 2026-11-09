import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import type { CanvasSource, LngLat } from 'maplibre-gl'
// MapLibre 6 ships its worker as a separate module and resolves it relative to its
// own URL, which breaks under bundlers. Let Vite emit the file and point MapLibre at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

setWorkerUrl(workerUrl)

export interface Bounds {
  west: number
  east: number
  north: number
  south: number
}

export function createMap(container: string, style: string, attribution: string): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style,
    center: [15, 22],
    zoom: 1.4,
    minZoom: 0.8,
    maxZoom: 9,
    attributionControl: false,
  })
  map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), 'top-right')
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
  // MapLibre opens the compact attribution on load, where it collides with the panels.
  // Start it collapsed; the "i" button reveals the full text.
  map.once('load', () => collapseAttribution(map))
  return map
}

/** Fold the compact attribution control if it is currently expanded. */
export function collapseAttribution(map: MapLibreMap): void {
  const attrib = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-attrib.maplibregl-compact-show')
  attrib?.querySelector<HTMLButtonElement>('.maplibregl-ctrl-attrib-button')?.click()
}

/**
 * Draws one decoded frame onto a canvas through the current colour lookup table
 * and drapes that canvas over the map in Web Mercator, beneath the basemap labels.
 */
export class RainOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private image: ImageData
  private added = false
  private lastGrey: Uint8Array | null = null
  private marker: Marker | null = null

  constructor(
    private map: MapLibreMap,
    width: number,
    height: number,
    private bounds: Bounds,
    private lut: Uint8ClampedArray,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')!
    this.image = this.ctx.createImageData(width, height)
  }

  add(): void {
    const { west, east, north, south } = this.bounds
    this.map.addSource('rain', {
      type: 'canvas',
      canvas: this.canvas,
      animate: false,
      coordinates: [[west, north], [east, north], [east, south], [west, south]],
    })
    const firstSymbol = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id
    this.map.addLayer(
      {
        id: 'rain',
        type: 'raster',
        source: 'rain',
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      },
      firstSymbol,
    )
    this.added = true
  }

  /** Swap the colour table (layer change) and repaint the current frame with it. */
  setLut(lut: Uint8ClampedArray): void {
    this.lut = lut
    if (this.lastGrey) this.show(this.lastGrey)
  }

  /** Colour a frame of grey levels and push it to the map. */
  show(grey: Uint8Array): void {
    this.lastGrey = grey
    const px = this.image.data
    const lut = this.lut
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
      const k = grey[i] * 4
      px[j] = lut[k]
      px[j + 1] = lut[k + 1]
      px[j + 2] = lut[k + 2]
      px[j + 3] = lut[k + 3]
    }
    this.ctx.putImageData(this.image, 0, 0)
    this.refresh()
  }

  onClick(handler: (lngLat: LngLat) => void): void {
    this.map.on('click', (e) => handler(e.lngLat))
  }

  setMarker(lon: number, lat: number): void {
    if (!this.marker) {
      const el = document.createElement('div')
      el.className = 'point-marker'
      el.setAttribute('aria-hidden', 'true')
      this.marker = new Marker({ element: el, anchor: 'center' })
    }
    this.marker.setLngLat([lon, lat]).addTo(this.map)
  }

  clearMarker(): void {
    this.marker?.remove()
  }

  private refresh(): void {
    if (!this.added) return
    const src = this.map.getSource('rain') as CanvasSource | undefined
    if (!src) return
    // A non-animated canvas source uploads its texture once. play() marks it live and
    // pause() re-reads the canvas synchronously before stopping, so the pair uploads
    // the new frame without leaving a per-frame re-upload running.
    src.play()
    src.pause()
    this.map.triggerRepaint()
  }
}
