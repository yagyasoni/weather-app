/**
 * Rule-based plain-English summary of a point's 6-hourly rainfall series.
 * Pure functions, no DOM, so they can be unit tested.
 */

export interface SeriesPoint {
  start: Date
  end: Date
  mm: number
}

export const WET_MM = 1.0    // a 6-hour total that counts as rain
export const TRACE_MM = 0.2  // below this the period is dry

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

export function formatMm(mm: number): string {
  if (mm < 0.1) return '0 mm'
  if (mm < 1) return 'under 1 mm'
  if (mm < 10) return `${mm.toFixed(1).replace(/\.0$/, '')} mm`
  return `${Math.round(mm)} mm`
}

function partOfDay(d: Date): string {
  const h = d.getHours()
  if (h < 5) return 'overnight'
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 21) return 'evening'
  return 'night'
}

/** "this afternoon", "tonight", "overnight", "tomorrow morning", "Thursday afternoon", "Thu 20 Nov". */
export function whenPhrase(t: Date, now: Date): string {
  const dayDiff = Math.round((startOfDay(t).getTime() - startOfDay(now).getTime()) / 86_400_000)
  const part = partOfDay(t)
  if (part === 'overnight' && dayDiff <= 1) return 'overnight'
  if (dayDiff === 0) return part === 'night' ? 'tonight' : `this ${part}`
  if (dayDiff === 1) return `tomorrow ${part}`
  if (dayDiff < 7) return `${weekdayFmt.format(t)} ${part}`
  return dayFmt.format(t)
}

function startOfDay(d: Date): Date {
  const s = new Date(d)
  s.setHours(0, 0, 0, 0)
  return s
}

function hoursPhrase(hours: number): string {
  if (hours < 24) return `${hours} hours`
  const days = hours / 24
  return days === 1 ? 'a day' : `${Math.round(days * 2) / 2} days`
}

export interface Summary {
  headline: string
  detail: string
  totals: { next24: number; next72: number; total: number }
}

export function summarize(series: SeriesPoint[], now = new Date()): Summary {
  const future = series.filter((p) => p.end.getTime() > now.getTime())
  const sum = (ps: SeriesPoint[]) => ps.reduce((a, p) => a + p.mm, 0)
  const totals = { next24: sum(future.slice(0, 4)), next72: sum(future.slice(0, 12)), total: sum(future) }
  const spanDays = Math.round((future.at(-1)?.end.getTime() ?? now.getTime()) / 86_400_000 - now.getTime() / 86_400_000)
  const span = spanDays >= 14 ? 'the next 15 days' : `the next ${spanDays} days`

  if (future.length === 0) {
    return { headline: 'This forecast has run out.', detail: 'Wait for the next run to be processed.', totals }
  }

  const first = future.findIndex((p) => p.mm >= WET_MM)
  if (first < 0) {
    const maxMm = Math.max(...future.map((p) => p.mm))
    return {
      headline: maxMm >= TRACE_MM ? `Only traces of rain in ${span}.` : `Dry for ${span}.`,
      detail: wettestDay(future) ?? '',
      totals,
    }
  }

  // the first wet spell: consecutive periods above the trace threshold
  let last = first
  while (last + 1 < future.length && future[last + 1].mm >= TRACE_MM) last++
  const spell = future.slice(first, last + 1)
  const spellMm = sum(spell)
  const spellHours = spell.length * 6
  const spellEnd = spell.at(-1)!.end

  let headline: string
  if (first === 0) {
    const after = future.slice(last + 1).findIndex((p) => p.mm >= WET_MM)
    const easing = `${whenPhrase(spellEnd, now)}`
    headline =
      spell.length === 1
        ? `Rain now, about ${formatMm(spellMm)} in the next 6 hours, easing ${easing}.`
        : `Rain now, about ${formatMm(spellMm)} over the next ${hoursPhrase(spellHours)}, easing ${easing}.`
    if (after < 0 && last + 1 < future.length) headline += ' Then mostly dry.'
  } else {
    const start = future[first].start
    const lightAndLong = spellHours >= 36 && spellMm / (spellHours / 24) < 5
    headline = lightAndLong
      ? `Dry until ${whenPhrase(start, now)}, then light rain on and off until ${whenPhrase(spellEnd, now)}, about ${formatMm(spellMm)} in total.`
      : `Dry until ${whenPhrase(start, now)}, then about ${formatMm(spellMm)} over ${hoursPhrase(spellHours)}.`
  }

  return { headline, detail: wettestDay(future) ?? '', totals }
}

/** "Wettest day Thu 13 Nov, 22 mm." or null when nothing reaches 1 mm in a day. */
function wettestDay(points: SeriesPoint[]): string | null {
  const byDay = new Map<string, { date: Date; mm: number }>()
  for (const p of points) {
    const key = startOfDay(p.end).toISOString()
    const entry = byDay.get(key) ?? { date: startOfDay(p.end), mm: 0 }
    entry.mm += p.mm
    byDay.set(key, entry)
  }
  let best: { date: Date; mm: number } | null = null
  for (const e of byDay.values()) if (!best || e.mm > best.mm) best = e
  if (!best || best.mm < WET_MM) return null
  return `Wettest day ${dayFmt.format(best.date)}, ${formatMm(best.mm)}.`
}
