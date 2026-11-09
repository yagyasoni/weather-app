import { DATA_ROOT, DECODE_CACHE, FALLBACK_DATA_ROOT, PRELOAD_CONCURRENCY } from './config'
import type { IntervalFrame, Latest, Manifest } from './types'
import { encodeGrey } from './types'

export interface Loaded {
  root: string
  latest: Latest
  manifest: Manifest
  usingFallback: boolean
}

function siteUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json() as Promise<T>
}

/** Load latest.json and the manifest it points at, falling back to the sample run. */
export async function loadLatest(): Promise<Loaded> {
  const roots = DATA_ROOT === FALLBACK_DATA_ROOT ? [DATA_ROOT] : [DATA_ROOT, FALLBACK_DATA_ROOT]
  let lastError: unknown
  for (const root of roots) {
    try {
      // cache-bust latest.json so a new run shows up without a hard reload
      const latest = await fetchJson<Latest>(siteUrl(`${root}/latest.json?t=${Date.now()}`))
      const manifest = await fetchJson<Manifest>(siteUrl(`${root}/${latest.manifest}`))
      return { root, latest, manifest, usingFallback: root !== DATA_ROOT }
    } catch (err) {
      lastError = err
      console.warn(`forecast data not available at ${root}:`, err)
    }
  }
  throw lastError
}

/** Small least-recently-used cache. */
class Lru<K, V> {
  private map = new Map<K, V>()
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null

/** Decode a grayscale PNG blob into one byte per pixel. */
async function decodeGrey(blob: Blob, width: number, height: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  if (!scratch) {
    scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas')
    scratch.width = width
    scratch.height = height
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const { data } = ctx.getImageData(0, 0, width, height)
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = data[j]
  return out
}

/**
 * Downloads frame PNGs and decodes them on demand. Compressed blobs for every
 * frame are kept (about 250 KB each); decoded frames live in a small LRU.
 */
export class FrameStore {
  private blobs = new Map<number, Promise<Blob>>()
  private decoded = new Lru<number, Uint8Array>(DECODE_CACHE)
  private inflight = new Map<number, Promise<Uint8Array>>()
  private loadedCount = 0
  onProgress: ((loaded: number, total: number) => void) | null = null

  constructor(
    private baseUrl: string,
    readonly frames: IntervalFrame[],
    private width: number,
    private height: number,
    private vmax: number,
  ) {}

  get length(): number {
    return this.frames.length
  }

  private blob(i: number): Promise<Blob> {
    let p = this.blobs.get(i)
    if (!p) {
      p = fetch(`${this.baseUrl}/${this.frames[i].file}`)
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} fetching ${this.frames[i].file}`)
          return res.blob()
        })
        .then((b) => {
          this.loadedCount++
          this.onProgress?.(this.loadedCount, this.frames.length)
          return b
        })
      p.catch(() => this.blobs.delete(i)) // allow a retry after a network error
      this.blobs.set(i, p)
    }
    return p
  }

  /** Decoded grey levels for frame i, row-major, width*height bytes. */
  grey(i: number): Promise<Uint8Array> {
    const cached = this.decoded.get(i)
    if (cached) return Promise.resolve(cached)
    let p = this.inflight.get(i)
    if (!p) {
      p = this.blob(i)
        .then((b) => decodeGrey(b, this.width, this.height))
        .then((g) => {
          this.decoded.set(i, g)
          this.inflight.delete(i)
          if (import.meta.env.DEV) this.selfCheck(i, g)
          return g
        })
      this.inflight.set(i, p)
    }
    return p
  }

  isReady(i: number): boolean {
    return this.decoded.get(i) !== undefined
  }

  /** Fetch every frame's PNG in the background, a few at a time, nearest to `from` first. */
  preloadAll(from = 0): void {
    const order: number[] = []
    for (let d = 0; order.length < this.frames.length; d++) {
      if (from + d < this.frames.length) order.push(from + d)
      if (d > 0 && from - d >= 0) order.push(from - d)
    }
    let next = 0
    const worker = async () => {
      while (next < order.length) {
        const i = order[next++]
        try {
          await this.blob(i)
        } catch {
          /* reported via console by blob(); the frame is retried when shown */
        }
      }
    }
    for (let k = 0; k < PRELOAD_CONCURRENCY; k++) void worker()
  }

  /** Dev-only: the decoded maximum must match the manifest's max_mm after encoding. */
  private selfCheck(i: number, g: Uint8Array): void {
    let max = 0
    for (let k = 0; k < g.length; k++) if (g[k] > max) max = g[k]
    const expected = encodeGrey(this.frames[i].max_mm, this.vmax)
    if (Math.abs(max - expected) > 1) {
      console.warn(`frame ${this.frames[i].file}: decoded max grey ${max}, manifest implies ${expected}. ` +
        'The browser may be colour-managing the PNG.')
    }
  }
}
