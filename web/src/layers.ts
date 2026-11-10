import { BLUE_DARK_TO_LIGHT, buildLut, gradientCss, hoursScale, ORANGE_LIGHT_TO_DARK, rainScale } from './colormap'
import { WET_MM } from './narrative'
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
  /** animated: steps through the interval frames; static: one file; computed: derived in the browser */
  kind: 'animated' | 'static' | 'computed'
  file?: string
  /** computed layers build their colour table once the hours for each value are known */
  lutFor?: (hours: number[]) => Uint8ClampedArray
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
  const { interval, accumulation } = manifest.layers

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

  // time from now until the first wet 6-hour period, computed in the browser (see firstrain.ts)
  {
    const maxHours = interval.frames[interval.frames.length - 1].step
    const scale = hoursScale(maxHours)
    layers.push({
      id: 'first_rain',
      label: 'Time to rain',
      legendTitle: 'Time until rain, from now',
      lut: new Uint8ClampedArray(256 * 4),
      lutFor: (hours) => buildLut(ORANGE_LIGHT_TO_DARK, scale, (g) => (g === 0 || g > hours.length ? null : hours[g - 1])),
      gradient: gradientCss(ORANGE_LIGHT_TO_DARK, scale),
      ticks: [0, 24, 72, 168, maxHours].map((h) => ({
        position: scale.position(h),
        label: h === 0 ? 'now' : hoursLabel(h).replace(' days', ' d').replace(' day', ' d'),
      })),
      kind: 'computed',
      readout: {
        title: 'Time until rain',
        sub: `from now to the first 6-hour period with more than ${WET_MM} mm; clear where none is expected`,
      },
    })
  }

  return layers
}
