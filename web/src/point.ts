import { formatLatLon } from './geo'
import { formatMm, summarize, type SeriesPoint } from './narrative'

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** A "nice" axis maximum at or above the data maximum. */
function niceMax(v: number): number {
  for (const n of [2, 5, 10, 20, 50, 100, 200, 500]) if (v <= n) return n
  return Math.ceil(v / 500) * 500
}

export interface PointPanelOptions {
  onOpen(): void
  onClose(): void
  onSelectFrame(index: number): void
}

/**
 * The selected-location card: headline summary, totals, and a 15-day bar chart
 * of 6-hourly rain. Re-renders the chart whenever its container resizes.
 */
export class PointPanel {
  private root = document.getElementById('point') as HTMLElement
  private titleEl = document.getElementById('point-title')!
  private subEl = document.getElementById('point-sub')!
  private statsEl = document.getElementById('point-stats')!
  private summaryEl = document.getElementById('point-summary')!
  private chartEl = document.getElementById('point-chart')!
  private tooltip = document.getElementById('point-tooltip')!
  private series: SeriesPoint[] = []
  private current = 0
  private now = new Date()
  private bars: SVGRectElement[] = []

  constructor(private opts: PointPanelOptions) {
    document.getElementById('point-close')!.addEventListener('click', () => this.hide())
    new ResizeObserver(() => this.renderChart()).observe(this.chartEl)
  }

  get visible(): boolean {
    return !this.root.hidden
  }

  setLoading(lat: number, lon: number): void {
    this.titleEl.textContent = formatLatLon(lat, lon)
    this.subEl.textContent = 'Loading 15-day outlook…'
    this.summaryEl.textContent = ''
    this.statsEl.replaceChildren()
    this.chartEl.replaceChildren()
    this.series = []
    this.show()
  }

  /** The outlook could not be loaded; offer a retry instead of an endless "Loading". */
  setError(lat: number, lon: number, onRetry: () => void): void {
    this.titleEl.textContent = formatLatLon(lat, lon)
    this.subEl.textContent = ''
    this.statsEl.replaceChildren()
    this.chartEl.replaceChildren()
    this.series = []
    const retry = document.createElement('button')
    retry.className = 'retry-btn'
    retry.textContent = 'Retry'
    retry.addEventListener('click', onRetry)
    this.summaryEl.replaceChildren('Could not load the outlook for this location. ', retry)
    this.show()
  }

  setSeries(lat: number, lon: number, series: SeriesPoint[], now = new Date()): void {
    this.series = series
    this.now = now
    this.titleEl.textContent = formatLatLon(lat, lon)
    const s = summarize(series, now)
    this.summaryEl.textContent = [s.headline, s.detail].filter(Boolean).join(' ')
    this.statsEl.replaceChildren(
      this.stat('Next 24 h', s.totals.next24),
      this.stat('Next 3 days', s.totals.next72),
      this.stat('Next 15 days', s.totals.total),
    )
    this.renderChart()
    this.setCurrent(this.current)
    this.show()
  }

  /** Highlight the timeline's current frame and show its value. */
  setCurrent(index: number): void {
    this.current = index
    this.bars.forEach((b, i) => b.classList.toggle('current', i === index))
    const p = this.series[index]
    if (p) {
      this.subEl.textContent = `${formatMm(p.mm)} in the 6 h to ${timeFmt.format(p.end)} ${dayFmt.format(p.end)}`
    }
  }

  show(): void {
    const wasHidden = this.root.hidden
    this.root.hidden = false
    document.body.classList.add('point-open')
    if (wasHidden) this.opts.onOpen()
  }

  hide(): void {
    this.root.hidden = true
    document.body.classList.remove('point-open')
    this.opts.onClose()
  }

  private stat(label: string, mm: number): HTMLElement {
    const tile = document.createElement('div')
    tile.className = 'stat'
    const v = document.createElement('div')
    v.className = 'stat-value'
    v.textContent = formatMm(mm)
    const l = document.createElement('div')
    l.className = 'stat-label'
    l.textContent = label
    tile.append(v, l)
    return tile
  }

  private renderChart(): void {
    this.chartEl.replaceChildren()
    this.bars = []
    if (this.series.length === 0) return
    const width = Math.max(this.chartEl.clientWidth, 200)
    const height = 124
    const m = { top: 14, right: 6, bottom: 22, left: 30 }
    const plotW = width - m.left - m.right
    const plotH = height - m.top - m.bottom
    const n = this.series.length
    const slot = plotW / n
    const barW = Math.max(2, slot - 2)
    const yMax = niceMax(Math.max(2, ...this.series.map((p) => p.mm)))
    const y = (mm: number) => m.top + plotH - (Math.min(mm, yMax) / yMax) * plotH

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'bar-chart', role: 'img' })
    svg.setAttribute('aria-label', `6-hourly rain for the next 15 days, up to ${yMax} mm per period`)

    // recessive grid and axis labels
    for (const v of [0, yMax / 2, yMax]) {
      svg.append(svgEl('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }))
      const label = svgEl('text', { x: m.left - 6, y: y(v) + 3.5, class: 'axis-label', 'text-anchor': 'end' })
      label.textContent = String(v)
      svg.append(label)
    }

    // bars
    const nowMs = this.now.getTime()
    this.series.forEach((p, i) => {
      const top = y(p.mm)
      const h = Math.max(0, m.top + plotH - top)
      const bar = svgEl('rect', {
        x: m.left + i * slot + (slot - barW) / 2,
        y: h > 0 ? top : m.top + plotH,
        width: barW,
        height: h,
        rx: Math.min(1.5, barW / 2),
        class: `bar${p.end.getTime() <= nowMs ? ' past' : ''}`,
      })
      svg.append(bar)
      this.bars.push(bar)
    })

    // "now" marker, so it is clear which bars the summary sentence is about
    const nowIdx = this.series.findIndex((p) => p.start.getTime() <= nowMs && nowMs < p.end.getTime())
    if (nowIdx >= 0) {
      const p = this.series[nowIdx]
      const frac = (nowMs - p.start.getTime()) / (p.end.getTime() - p.start.getTime())
      const x = m.left + (nowIdx + frac) * slot
      svg.append(svgEl('line', { x1: x, x2: x, y1: m.top - 1, y2: m.top + plotH, class: 'now-line' }))
      const label = svgEl('text', { x: Math.min(Math.max(x, m.left + 10), width - m.right - 10), y: m.top - 3, class: 'axis-label now-label', 'text-anchor': 'middle' })
      label.textContent = 'now'
      svg.append(label)
    }

    // day ticks at local midnight
    let lastDay = ''
    this.series.forEach((p, i) => {
      const day = p.end.toDateString()
      if (day === lastDay || i === 0) {
        lastDay = day
        return
      }
      lastDay = day
      const x = m.left + i * slot
      svg.append(svgEl('line', { x1: x, x2: x, y1: m.top + plotH, y2: m.top + plotH + 4, class: 'axis' }))
      if (slot * 4 >= 26) {
        const t = svgEl('text', { x, y: height - 6, class: 'axis-label', 'text-anchor': 'middle' })
        t.textContent = weekdayFmt.format(p.end)
        svg.append(t)
      }
    })

    // hover and tap layer: one hit target per bar, wider than the mark
    const hit = svgEl('rect', { x: m.left, y: 0, width: plotW, height, fill: 'transparent' })
    const indexAt = (clientX: number) => {
      const rect = svg.getBoundingClientRect()
      const i = Math.floor(((clientX - rect.left - m.left) / plotW) * n)
      return Math.min(Math.max(i, 0), n - 1)
    }
    hit.addEventListener('pointermove', (e) => this.showTooltip(indexAt(e.clientX), svg, m, slot, y))
    hit.addEventListener('pointerleave', () => this.hideTooltip())
    hit.addEventListener('click', (e) => this.opts.onSelectFrame(indexAt(e.clientX)))
    svg.append(hit)

    this.chartEl.append(svg)
    this.setCurrent(this.current)
  }

  private showTooltip(i: number, svg: SVGSVGElement, m: { left: number; top: number }, slot: number, y: (mm: number) => number): void {
    const p = this.series[i]
    if (!p) return
    this.bars.forEach((b, k) => b.classList.toggle('hover', k === i))
    this.tooltip.textContent = `${dayFmt.format(p.end)} · ${timeFmt.format(p.start)}–${timeFmt.format(p.end)} · ${formatMm(p.mm)}`
    this.tooltip.hidden = false
    const chartRect = this.chartEl.getBoundingClientRect()
    const svgRect = svg.getBoundingClientRect()
    const x = svgRect.left - chartRect.left + m.left + (i + 0.5) * slot
    const top = svgRect.top - chartRect.top + y(p.mm) - 8
    const w = this.tooltip.offsetWidth
    this.tooltip.style.left = `${Math.min(Math.max(x - w / 2, 0), chartRect.width - w)}px`
    this.tooltip.style.top = `${top}px`
  }

  private hideTooltip(): void {
    this.tooltip.hidden = true
    this.bars.forEach((b) => b.classList.remove('hover'))
  }
}
