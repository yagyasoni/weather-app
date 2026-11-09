import { decodeMm } from './types'

/**
 * Sequential single-hue ramp for rainfall: the palette's blue steps 700..100.
 * On the dark basemap the anchor flips, so near-zero rain recedes toward the
 * dark surface and the heaviest rain takes the lightest step.
 */
const BLUE_700_TO_100 = [
  '#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5',
  '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb',
]

export const LEGEND_TOP_MM = 50   // the ramp reaches its lightest step here; heavier rain holds it
export const DRY_BELOW_MM = 0.2   // fully transparent below this (a trace, not rain)
export const LEGEND_TICKS_MM = [0, 1, 2, 5, 10, 20, 50]

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const STEPS: Rgb[] = BLUE_700_TO_100.map(hexToRgb)

/** Position along the ramp, 0..1. Square root gives light rain visual range. */
export function rampPosition(mm: number): number {
  return Math.sqrt(Math.min(Math.max(mm, 0), LEGEND_TOP_MM) / LEGEND_TOP_MM)
}

/** Linear interpolation between ramp steps at position t in 0..1. */
export function rampColor(t: number): Rgb {
  const x = Math.min(Math.max(t, 0), 1) * (STEPS.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = STEPS[i]
  const b = STEPS[Math.min(i + 1, STEPS.length - 1)]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Opacity: transparent when dry, rising from 0.3 to 0.92 by 2 mm, then constant. */
export function rampAlpha(mm: number): number {
  if (mm < DRY_BELOW_MM) return 0
  const t = Math.min((mm - DRY_BELOW_MM) / (2 - DRY_BELOW_MM), 1)
  return 0.3 + 0.62 * t
}

/** 256 straight-alpha RGBA entries indexed by the PNG grey level. */
export function buildLut(vmax: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let g = 0; g < 256; g++) {
    const mm = decodeMm(g, vmax)
    const [r, gg, b] = rampColor(rampPosition(mm))
    lut[g * 4] = r
    lut[g * 4 + 1] = gg
    lut[g * 4 + 2] = b
    lut[g * 4 + 3] = Math.round(rampAlpha(mm) * 255)
  }
  return lut
}

/** CSS gradient for the legend bar, sampled along the same sqrt positions as the map. */
export function legendGradientCss(samples = 24): string {
  const stops: string[] = []
  for (let k = 0; k <= samples; k++) {
    const t = k / samples
    const mm = t * t * LEGEND_TOP_MM
    const [r, g, b] = rampColor(t)
    stops.push(`rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${rampAlpha(mm).toFixed(2)}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}
