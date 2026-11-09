import { DATA_ROOT, DECODE_CACHE, FALLBACK_DATA_ROOT, PRELOAD_CONCURRENCY } from './config'
import type { Latest, Manifest } from './types'

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

type Ctx2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function makeCanvas(width: number, height: number): Ctx2d {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx2d
  ctx.imageSmoothingEnabled = false
  return ctx
}

const BITMAP_OPTS: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }

/** Run `fn` over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Downloads the run's PNGs and decodes them on demand. Compressed blobs are kept
 * for every file requested (about 250 KB each); decoded frames live in a small LRU.
 */
export class FrameStore {
  private blobs = new Map<string, Promise<Blob>>()
  private decoded = new Lru<string, Uint8Array>(DECODE_CACHE)
  private inflight = new Map<string, Promise<Uint8Array>>()
  private full: Ctx2d | null = null
  private pixel: Ctx2d | null = null
  private loadedCount = 0
  private preloadTotal = 0
  onProgress: ((loaded: number, total: number) => void) | null = null
  /** Optional dev self-check: expected maximum grey level per file. */
  expectedMax = new Map<string, number>()

  constructor(
    private baseUrl: string,
    readonly width: number,
    readonly height: number,
  ) {}

  private blob(file: string): Promise<Blob> {
    let p = this.blobs.get(file)
    if (!p) {
      p = fetch(`${this.baseUrl}/${file}`)
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} fetching ${file}`)
          return res.blob()
        })
        .then((b) => {
          this.loadedCount++
          this.onProgress?.(this.loadedCount, this.preloadTotal)
          return b
        })
      p.catch(() => this.blobs.delete(file)) // allow a retry after a network error
      this.blobs.set(file, p)
    }
    return p
  }

  /** Decoded grey levels for a file, row-major, width*height bytes. */
  grey(file: string): Promise<Uint8Array> {
    const cached = this.decoded.get(file)
    if (cached) return Promise.resolve(cached)
    let p = this.inflight.get(file)
    if (!p) {
      p = this.blob(file)
        .then((b) => createImageBitmap(b, BITMAP_OPTS))
        .then((bitmap) => {
          this.full ??= makeCanvas(this.width, this.height)
          this.full.drawImage(bitmap, 0, 0)
          bitmap.close()
          const { data } = this.full.getImageData(0, 0, this.width, this.height)
          const out = new Uint8Array(this.width * this.height)
          for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = data[j]
          this.decoded.set(file, out)
          this.inflight.delete(file)
          if (import.meta.env.DEV) this.selfCheck(file, out)
          return out
        })
      this.inflight.set(file, p)
    }
    return p
  }

  /** One pixel's grey level, without materialising the whole frame when it is not cached. */
  async greyAt(file: string, x: number, y: number): Promise<number> {
    const cached = this.decoded.get(file)
    if (cached) return cached[y * this.width + x]
    const inflight = this.inflight.get(file)
    if (inflight) return (await inflight)[y * this.width + x]
    const bitmap = await createImageBitmap(await this.blob(file), BITMAP_OPTS)
    this.pixel ??= makeCanvas(1, 1)
    this.pixel.clearRect(0, 0, 1, 1)
    this.pixel.drawImage(bitmap, x, y, 1, 1, 0, 0, 1, 1)
    bitmap.close()
    return this.pixel.getImageData(0, 0, 1, 1).data[0]
  }

  /** The same pixel across many files, a few decodes at a time. */
  seriesAt(files: string[], x: number, y: number): Promise<number[]> {
    return mapLimit(files, 6, (f) => this.greyAt(f, x, y))
  }

  /** Fetch files in the background, a few at a time, nearest to index `from` first. */
  preload(files: string[], from = 0): void {
    this.preloadTotal = files.length
    const order: string[] = []
    for (let d = 0; order.length < files.length; d++) {
      if (from + d < files.length) order.push(files[from + d])
      if (d > 0 && from - d >= 0) order.push(files[from - d])
    }
    let next = 0
    const worker = async () => {
      while (next < order.length) {
        try {
          await this.blob(order[next++])
        } catch {
          /* already logged by fetch; retried when the frame is shown */
        }
      }
    }
    for (let k = 0; k < PRELOAD_CONCURRENCY; k++) void worker()
  }

  private selfCheck(file: string, g: Uint8Array): void {
    const expected = this.expectedMax.get(file)
    if (expected === undefined) return
    let max = 0
    for (let k = 0; k < g.length; k++) if (g[k] > max) max = g[k]
    if (Math.abs(max - expected) > 1) {
      console.warn(`${file}: decoded max grey ${max}, manifest implies ${expected}. The browser may be colour-managing the PNG.`)
    }
  }
}
