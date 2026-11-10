// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAYBACK_MS } from './config'
import { Timeline } from './timeline'
import type { IntervalFrame } from './types'

const frames: IntervalFrame[] = Array.from({ length: 10 }, (_, i) => ({
  step: (i + 1) * 6, interval_hours: 6, valid_time: new Date(Date.UTC(2026, 10, 10, 18 + i * 6)).toISOString(), file: `tp_${i}.png`, max_mm: 0,
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  document.body.innerHTML = `
    <footer class="timeline">
      <button id="play"></button>
      <div id="valid-time"></div><div id="lead"></div>
      <div class="slider-wrap"><input id="slider" type="range" min="0" max="0" value="0" /><div id="ticks"></div></div>
      <div id="progress"></div>
    </footer>`
})
afterEach(() => vi.useRealTimers())

describe('Timeline', () => {
  it('keeps rendering later frames after one frame fails', async () => {
    const shown: number[] = []
    const errors: unknown[] = []
    const t = new Timeline(frames, async (i) => {
      if (i === 3) throw new Error('fetch failed')
      shown.push(i)
    })
    t.onError = (e) => errors.push(e)

    await t.setIndex(2)
    await t.setIndex(3)
    await t.setIndex(4)

    expect(shown).toEqual([2, 4])
    expect(errors).toHaveLength(1)
  })

  it('runs a single tick chain when paused and resumed during a slow frame', async () => {
    const slow = deferred()
    const shown: number[] = []
    const t = new Timeline(frames, async (i) => {
      if (i === 1) await slow.promise // the first frame of playback is still downloading
      shown.push(i)
    })

    t.play()
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS) // a tick is now waiting on frame 1
    t.pause()
    t.play()
    slow.resolve()
    await vi.advanceTimersByTimeAsync(0)

    const before = t.index
    for (let k = 1; k <= 4; k++) {
      await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
      expect(t.index).toBe(before + k) // exactly one frame per interval, not two
    }
    t.pause()
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS * 3)
    expect(t.index).toBe(before + 4) // and pause stops everything
  })

  it('leaves Space to a focused button instead of toggling as well', () => {
    const t = new Timeline(frames, async () => {})
    const play = document.getElementById('play')!
    play.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(t.playing).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(t.playing).toBe(true)
    t.pause()
  })
})
