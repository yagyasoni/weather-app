import { describe, expect, it } from 'vitest'
import { formatLatLon, lonLatToPixel, wrapLon } from './geo'

describe('wrapLon', () => {
  it('leaves normal longitudes alone', () => {
    expect(wrapLon(0)).toBe(0)
    expect(wrapLon(92.27)).toBeCloseTo(92.27)
    expect(wrapLon(-180)).toBe(-180)
  })
  it('wraps values from repeated world copies', () => {
    expect(wrapLon(538)).toBeCloseTo(178)   // Fiji, one world to the east
    expect(wrapLon(-182)).toBeCloseTo(178)  // just past the antimeridian going west
    expect(wrapLon(180)).toBe(-180)
  })
})

describe('formatLatLon', () => {
  it('never prints a longitude outside 180', () => {
    expect(formatLatLon(-17.7, 538)).toBe('17.70°S, 178.00°E')
    expect(formatLatLon(-17.7, -182)).toBe('17.70°S, 178.00°E')
  })
})

describe('lonLatToPixel', () => {
  it('maps a wrapped and an unwrapped longitude to the same pixel', () => {
    expect(lonLatToPixel(538, -17.7, 1440, 1440)).toEqual(lonLatToPixel(178, -17.7, 1440, 1440))
  })
  it('puts the origin at the image centre and clamps the poles', () => {
    expect(lonLatToPixel(0, 0, 1440, 1440)).toEqual({ x: 720, y: 720 })
    expect(lonLatToPixel(0, 90, 1440, 1440).y).toBe(0)
    expect(lonLatToPixel(0, -90, 1440, 1440).y).toBe(1439)
  })
})
