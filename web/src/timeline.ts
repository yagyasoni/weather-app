import { PLAYBACK_MS } from './config'
import type { IntervalFrame } from './types'

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const tickFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

/** Slider, play button, time readout and day ticks. Calls `show(i)` to render a frame. */
export class Timeline {
  index = 0
  playing = false
  /** Called whenever the index changes, before the frame is rendered. */
  onChange: ((index: number) => void) | null = null
  /** Called when a frame fails to render; later frames are unaffected. */
  onError: ((err: unknown) => void) | null = null
  private playToken = 0
  private mode: 'animated' | 'static' = 'animated'
  private timer: number | undefined
  private rendering: Promise<void> = Promise.resolve()
  private panel = document.querySelector<HTMLElement>('.timeline')!
  private slider = el<HTMLInputElement>('slider')
  private playBtn = el<HTMLButtonElement>('play')
  private validEl = el<HTMLDivElement>('valid-time')
  private leadEl = el<HTMLDivElement>('lead')
  private progressEl = el<HTMLDivElement>('progress')
  private tickEls: HTMLSpanElement[] = []

  constructor(
    readonly frames: IntervalFrame[],
    private show: (index: number) => Promise<void>,
  ) {
    this.slider.max = String(frames.length - 1)
    this.slider.addEventListener('input', () => {
      this.pause()
      void this.setIndex(Number(this.slider.value))
    })
    this.playBtn.addEventListener('click', () => this.toggle())
    document.addEventListener('keydown', (e) => this.onKey(e))
    this.renderTicks()
    new ResizeObserver(() => this.fitTicks()).observe(this.slider.parentElement!)
  }

  /** Render frame i, coalescing rapid requests so only the latest is drawn. */
  setIndex(i: number): Promise<void> {
    const clamped = Math.min(Math.max(i, 0), this.frames.length - 1)
    this.index = clamped
    this.slider.value = String(clamped)
    this.onChange?.(clamped)
    if (this.mode === 'static') return this.rendering
    this.renderReadout()
    this.rendering = this.rendering.then(async () => {
      if (this.index !== clamped) return // superseded
      try {
        await this.show(clamped)
      } catch (err) {
        this.onError?.(err) // keep the chain alive so the next frame can still render
      }
    })
    return this.rendering
  }

  /** Static layers freeze the timeline and replace the readout with the layer's own text. */
  setMode(mode: 'animated' | 'static', readout?: { title: string; sub: string }): void {
    this.mode = mode
    if (mode === 'static') {
      this.pause()
      this.slider.disabled = true
      this.playBtn.disabled = true
      this.panel.classList.add('static')
      if (readout) {
        this.validEl.textContent = readout.title
        this.leadEl.textContent = readout.sub
      }
    } else {
      this.slider.disabled = false
      this.playBtn.disabled = false
      this.panel.classList.remove('static')
      this.renderReadout()
      void this.setIndex(this.index)
    }
  }

  play(): void {
    if (this.playing || this.mode === 'static') return
    this.playing = true
    this.playBtn.classList.add('playing')
    this.playBtn.setAttribute('aria-pressed', 'true')
    this.playBtn.setAttribute('aria-label', 'Pause')
    // Each play() gets a token; a tick that was mid-load when playback was paused and
    // restarted sees a stale token and stops, so only one chain ever advances frames.
    const token = ++this.playToken
    const live = () => this.playing && token === this.playToken
    const tick = async () => {
      if (!live()) return
      await this.setIndex((this.index + 1) % this.frames.length)
      if (live()) this.timer = window.setTimeout(tick, PLAYBACK_MS)
    }
    this.timer = window.setTimeout(tick, PLAYBACK_MS)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.playToken++
    window.clearTimeout(this.timer)
    this.playBtn.classList.remove('playing')
    this.playBtn.setAttribute('aria-pressed', 'false')
    this.playBtn.setAttribute('aria-label', 'Play')
  }

  toggle(): void {
    this.playing ? this.pause() : this.play()
  }

  setProgress(loaded: number, total: number): void {
    if (loaded >= total) {
      this.progressEl.textContent = ''
      this.progressEl.hidden = true
    } else {
      this.progressEl.hidden = false
      this.progressEl.textContent = `Loading ${loaded}/${total}`
    }
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
    if (this.mode === 'static') return
    // a focused button handles Space itself; acting here too would toggle twice
    if (e.key === ' ' && target?.tagName === 'BUTTON') return
    switch (e.key) {
      case ' ':
        e.preventDefault()
        this.toggle()
        break
      case 'ArrowRight':
        this.pause()
        void this.setIndex(this.index + 1)
        break
      case 'ArrowLeft':
        this.pause()
        void this.setIndex(this.index - 1)
        break
      case 'Home':
        this.pause()
        void this.setIndex(0)
        break
      case 'End':
        this.pause()
        void this.setIndex(this.frames.length - 1)
        break
    }
  }

  private renderReadout(): void {
    const f = this.frames[this.index]
    const end = new Date(f.valid_time)
    const start = new Date(end.getTime() - f.interval_hours * 3600_000)
    const sameDay = start.toDateString() === end.toDateString()
    this.validEl.textContent = sameDay
      ? `${dayFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`
      : `${dayFmt.format(start)} ${timeFmt.format(start)} – ${dayFmt.format(end)} ${timeFmt.format(end)}`
    this.leadEl.textContent = `Forecast hour +${f.step}`
  }

  /** One label per local calendar day, placed at the first frame ending on that day. */
  private renderTicks(): void {
    const ticks = el<HTMLDivElement>('ticks')
    ticks.replaceChildren()
    this.tickEls = []
    let lastDay = ''
    const n = this.frames.length - 1
    this.frames.forEach((f, i) => {
      const end = new Date(f.valid_time)
      const day = end.toDateString()
      if (day === lastDay) return
      lastDay = day
      if (i === 0) return // the first frame's day is implied by the readout
      const tick = document.createElement('span')
      tick.className = 'tick'
      tick.dataset.pos = String(i / n)
      tick.style.left = `${(i / n) * 100}%`
      tick.textContent = tickFmt.format(end)
      ticks.appendChild(tick)
      this.tickEls.push(tick)
    })
    this.fitTicks()
  }

  /** Hide labels that would collide at the current width; the first of each gap wins. */
  private fitTicks(): void {
    const ticks = el<HTMLDivElement>('ticks')
    const width = ticks.clientWidth
    if (!width || this.tickEls.length === 0) return
    for (const tick of this.tickEls) tick.hidden = false
    const labelW = Math.max(...this.tickEls.map((t) => t.offsetWidth)) + 10
    let lastX = -Infinity
    for (const tick of this.tickEls) {
      const x = Number(tick.dataset.pos) * width
      if (x - lastX >= labelW) {
        lastX = x
      } else {
        tick.hidden = true
      }
    }
  }
}
