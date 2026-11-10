import { describe, expect, it } from 'vitest'
import { accumulateFirstRain, futureFrames, wetThresholdGrey } from './firstrain'
import type { IntervalFrame } from './types'
import { decodeMm } from './types'

const RUN = Date.parse('2026-11-10T12:00:00Z')
const HOUR = 3600_000
const frames: IntervalFrame[] = [6, 12, 18, 24].map((step) => ({
  step, interval_hours: 6, valid_time: new Date(RUN + step * HOUR).toISOString(), file: `tp_${step}.png`, max_mm: 0,
}))

describe('futureFrames', () => {
  it('counts from now, not from the start of the run', () => {
    // 9 hours into the run: the +6 h interval is over, +12 h is under way
    const future = futureFrames(frames, RUN + 9 * HOUR)
    expect(future.map((f) => f.index)).toEqual([1, 2, 3])
    expect(future.map((f) => f.hoursUntilStart)).toEqual([0, 3, 9])
  })
  it('keeps every frame when viewed at the run time', () => {
    expect(futureFrames(frames, RUN).map((f) => f.hoursUntilStart)).toEqual([0, 6, 12, 18])
  })
  it('is empty once the forecast has run out', () => {
    expect(futureFrames(frames, RUN + 48 * HOUR)).toEqual([])
  })
})

describe('wetThresholdGrey', () => {
  it('is the first grey level above the threshold', () => {
    const g = wetThresholdGrey(200, 1)
    expect(decodeMm(g, 200)).toBeGreaterThan(1)
    expect(decodeMm(g - 1, 200)).toBeLessThanOrEqual(1)
  })
})

describe('accumulateFirstRain', () => {
  it('records the first wet frame per pixel and never overwrites it', () => {
    const thr = 20
    const out = new Uint8Array(4)
    accumulateFirstRain(out, Uint8Array.of(0, 30, 0, 19), 0, thr)   // only pixel 1 is wet
    accumulateFirstRain(out, Uint8Array.of(25, 99, 0, 20), 1, thr)  // pixels 0 and 3 turn wet
    accumulateFirstRain(out, Uint8Array.of(99, 99, 0, 99), 2, thr)
    expect([...out]).toEqual([2, 1, 0, 2])   // 0 = stays dry for the whole forecast
  })
  it('ignores rain that fell before now because past frames are never passed in', () => {
    // pixel 0 was wet only in the +6 h frame, which is over 9 hours into the run
    const greys = [Uint8Array.of(200), Uint8Array.of(0), Uint8Array.of(0), Uint8Array.of(0)]
    const out = new Uint8Array(1)
    futureFrames(frames, RUN + 9 * HOUR).forEach((f, j) => accumulateFirstRain(out, greys[f.index], j, 20))
    expect(out[0]).toBe(0)
  })
})
