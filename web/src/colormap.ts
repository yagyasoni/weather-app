/**
 * Colour ramps and lookup tables. Both ramps are single-hue sequential scales
 * with monotonic OKLCH lightness, stepped to match the palette's blue 700..100.
 */

export type Rgb = [number, number, number]

export interface Ramp {
  /** Colours in display order for increasing position 0..1. */
  steps: Rgb[]
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const BLUE_700_TO_100 = [
  '#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5',
  '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb',
]
const ORANGE_700_TO_100 = [
  '#621e01', '#762500', '#8a2d01', '#9f3603', '#b53e01', '#c94a11', '#d95926',
  '#ea6938', '#ef8059', '#f39776', '#f7ad93', '#f9c2af', '#fad7cb',
]

/** Rain: on the dark basemap the anchor flips, so near-zero is dark and heavy rain is light. */
export const BLUE_DARK_TO_LIGHT: Ramp = { steps: BLUE_700_TO_100.map(hexToRgb) }
/** Time to rain: soon is light and salient, far off recedes toward the dark surface. */
export const ORANGE_LIGHT_TO_DARK: Ramp = { steps: ORANGE_700_TO_100.map(hexToRgb).reverse() }

export function rampColor(ramp: Ramp, t: number): Rgb {
  const steps = ramp.steps
  const x = Math.min(Math.max(t, 0), 1) * (steps.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = steps[i]
  const b = steps[Math.min(i + 1, steps.length - 1)]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Maps a data value to a ramp position and an opacity. */
export interface ValueScale {
  position(value: number): number
  alpha(value: number): number
  /** Inverse of position, used to draw the legend. */
  valueAt(t: number): number
}

/** Square-root scale for rainfall: transparent below `dryBelow`, opaque by `opaqueBy`. */
export function rainScale(top: number, dryBelow: number, opaqueBy: number): ValueScale {
  return {
    position: (mm) => Math.sqrt(Math.min(Math.max(mm, 0), top) / top),
    alpha: (mm) => {
      if (mm < dryBelow) return 0
      const t = Math.min((mm - dryBelow) / (opaqueBy - dryBelow), 1)
      return 0.3 + 0.62 * t
    },
    valueAt: (t) => t * t * top,
  }
}

/** Square-root scale for hours until rain: near-term gets most of the ramp. */
export function hoursScale(maxHours: number, alpha = 0.85): ValueScale {
  return {
    position: (h) => Math.sqrt(Math.min(Math.max(h, 0), maxHours) / maxHours),
    alpha: () => alpha,
    valueAt: (t) => t * t * maxHours,
  }
}

/**
 * 256 straight-alpha RGBA entries indexed by PNG grey level. `valueOf` turns a
 * grey level into a data value, or null for "nothing here" (fully transparent).
 */
export function buildLut(ramp: Ramp, scale: ValueScale, valueOf: (g: number) => number | null): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let g = 0; g < 256; g++) {
    const v = valueOf(g)
    if (v === null) continue
    const [r, gg, b] = rampColor(ramp, scale.position(v))
    lut[g * 4] = r
    lut[g * 4 + 1] = gg
    lut[g * 4 + 2] = b
    lut[g * 4 + 3] = Math.round(scale.alpha(v) * 255)
  }
  return lut
}

/** CSS gradient for a legend bar, sampled at the same positions the map uses. */
export function gradientCss(ramp: Ramp, scale: ValueScale, samples = 24): string {
  const stops: string[] = []
  for (let k = 0; k <= samples; k++) {
    const t = k / samples
    const [r, g, b] = rampColor(ramp, t)
    const a = scale.alpha(scale.valueAt(t))
    stops.push(`rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(2)}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}
