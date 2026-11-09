import { BLUE_DARK_TO_LIGHT, buildLut, gradientCss, hoursScale, ORANGE_LIGHT_TO_DARK, rainScale } from './colormap'
import type { Manifest } from './types'
import { decodeMm } from './types'

export interface LegendTick {
  position: number // 0..1 along the bar
  label: string
}

export interface LayerDef {
  id: string
  label: string
  legendTitle: string
  lut: Uint8ClampedArray
  gradient: string
  ticks: LegendTick[]
  /** animated layers step through the interval frames; static ones show one file */
  kind: 'animated' | 'static'
  file?: string
  readout?: { title: string; sub: string }
}

const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
})

function hoursLabel(h: number): string {
  if (h < 24) return `${h} h`
  const d = h / 24
  return `${Number.isInteger(d) ? d : d.toFixed(1)} ${d === 1 ? 'day' : 'days'}`
}

export function buildLayers(manifest: Manifest): LayerDef[] {
  const layers: LayerDef[] = []
  const { interval, accumulation, first_rain } = manifest.layers

  // 6-hourly rain, animated along the timeline
  {
    const vmax = interval.encoding.vmax
    const scale = rainScale(50, 0.2, 2)
    layers.push({
      id: 'interval',
      label: '6-hourly',
      legendTitle: 'Rain in 6 h, mm',
      lut: buildLut(BLUE_DARK_TO_LIGHT, scale, (g) => decodeMm(g, vmax)),
      gradient: gradientCss(BLUE_DARK_TO_LIGHT, scale),
      ticks: [0, 1, 2, 5, 10, 20, 50].map((mm) => ({ position: scale.position(mm), label: mm === 50 ? '50+' : String(mm) })),
      kind: 'animated',
    })
  }

  // accumulations since the start of the forecast
  for (const frame of accumulation.frames) {
    const vmax = accumulation.encoding.vmax
    const scale = rainScale(200, 1, 10)
    layers.push({
      id: `acc${frame.hours}`,
      label: hoursLabel(frame.hours),
      legendTitle: `Rain total, next ${hoursLabel(frame.hours)}, mm`,
      lut: buildLut(BLUE_DARK_TO_LIGHT, scale, (g) => decodeMm(g, vmax)),
      gradient: gradientCss(BLUE_DARK_TO_LIGHT, scale),
      ticks: [0, 5, 10, 25, 50, 100, 200].map((mm) => ({ position: scale.position(mm), label: mm === 200 ? '200+' : String(mm) })),
      kind: 'static',
      file: frame.file,
      readout: {
        title: `Rain total, next ${hoursLabel(frame.hours)}`,
        sub: `from the run start to ${dayTimeFmt.format(new Date(frame.valid_time))}`,
      },
    })
  }

  // hours until the first wet 6-hour period
  {
    const { steps, threshold_mm, none_value } = first_rain.encoding
    const maxHours = steps[steps.length - 1]
    const scale = hoursScale(maxHours)
    layers.push({
      id: 'first_rain',
      label: 'Time to rain',
      legendTitle: 'Time until rain',
      lut: buildLut(ORANGE_LIGHT_TO_DARK, scale, (g) => (g === none_value || g > steps.length ? null : steps[g - 1])),
      gradient: gradientCss(ORANGE_LIGHT_TO_DARK, scale),
      ticks: [6, 24, 72, 168, 360].map((h) => ({ position: scale.position(h), label: hoursLabel(h).replace(' days', ' d').replace(' day', ' d') })),
      kind: 'static',
      file: first_rain.file,
      readout: {
        title: 'Time until rain',
        sub: `first 6-hour period with more than ${threshold_mm} mm; clear where none is expected`,
      },
    })
  }

  return layers
}
