/**
 * "Time until rain", measured from now rather than from the start of the model run.
 * Computed in the browser from the 6-hourly frames so it stays correct as the run ages.
 */
import type { FrameStore } from './data'
import type { IntervalFrame } from './types'
import { decodeMm } from './types'

export interface FutureFrame {
  index: number            // position in the manifest's frame list
  hoursUntilStart: number  // 0 when the interval has already begun
}

/** Frames whose interval has not fully passed, with the wait until each one starts. */
export function futureFrames(frames: IntervalFrame[], nowMs: number): FutureFrame[] {
  const out: FutureFrame[] = []
  frames.forEach((f, index) => {
    const end = new Date(f.valid_time).getTime()
    if (end <= nowMs) return
    const start = end - f.interval_hours * 3600_000
    out.push({ index, hoursUntilStart: Math.max(0, (start - nowMs) / 3600_000) })
  })
  return out
}

/** Smallest grey level that decodes to more than `thresholdMm`. */
export function wetThresholdGrey(vmax: number, thresholdMm: number): number {
  for (let g = 0; g < 256; g++) if (decodeMm(g, vmax) > thresholdMm) return g
  return 256
}

/**
 * Fold one frame into the result: every pixel that is still 0 ("no rain yet") and
 * is wet in this frame is set to ordinal + 1. Call with ordinals in time order.
 */
export function accumulateFirstRain(out: Uint8Array, grey: Uint8Array, ordinal: number, thresholdGrey: number): void {
  const value = ordinal + 1
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0 && grey[i] >= thresholdGrey) out[i] = value
  }
}

export interface FirstRain {
  grey: Uint8Array   // 0 = no rain within the forecast, k = wet first in future frame k - 1
  hours: number[]    // hours from now for each future frame, indexed by k - 1
}

export async function computeFirstRain(
  store: FrameStore, frames: IntervalFrame[], vmax: number, thresholdMm: number, nowMs: number,
): Promise<FirstRain> {
  const future = futureFrames(frames, nowMs)
  const grey = new Uint8Array(store.width * store.height)
  const threshold = wetThresholdGrey(vmax, thresholdMm)
  for (let j = 0; j < future.length; j++) {
    accumulateFirstRain(grey, await store.grey(frames[future[j].index].file), j, threshold)
  }
  return { grey, hours: future.map((f) => f.hoursUntilStart) }
}
