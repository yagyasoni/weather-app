/** Shapes written by pipeline/build.py. Keep in sync with its manifest section. */

export interface Latest {
  run_id: string
  run: string
  model: string
  generated_at: string
  manifest: string
}

export interface SqrtEncoding {
  type: 'sqrt'
  vmax: number
  units: string
  decode: string
}

export interface IntervalFrame {
  step: number
  interval_hours: number
  valid_time: string
  file: string
  max_mm: number
}

export interface AccumulationFrame {
  hours: number
  valid_time: string
  file: string
  max_mm: number
}

export interface Manifest {
  model: string
  source: string
  run: string
  run_id: string
  generated_at: string
  parameter: { name: string; description: string; units: string; source_units: string }
  grid: { resolution_deg: number }
  image: {
    width: number
    height: number
    projection: string
    bounds: { west: number; east: number; north: number; south: number }
  }
  layers: {
    interval: { description: string; encoding: SqrtEncoding; frames: IntervalFrame[] }
    accumulation: { description: string; encoding: SqrtEncoding; frames: AccumulationFrame[] }
  }
  attribution: string
  license_url: string
}

/** Grey level 0..255 -> millimetres, inverse of the pipeline's encode_sqrt. */
export function decodeMm(g: number, vmax: number): number {
  const t = g / 255
  return t * t * vmax
}

/** Millimetres -> grey level, same rounding as the pipeline. Used for self-checks. */
export function encodeGrey(mm: number, vmax: number): number {
  return Math.round(Math.sqrt(Math.min(Math.max(mm, 0), vmax) / vmax) * 255)
}
