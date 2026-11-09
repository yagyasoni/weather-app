/** Web Mercator helpers shared by the overlay and the point query. */

export const MAX_LAT = 85.05112878

/** Longitude/latitude in degrees to the pixel of a Mercator image of the given size. */
export function lonLatToPixel(lon: number, lat: number, width: number, height: number): { x: number; y: number } {
  const lonW = ((((lon + 180) % 360) + 360) % 360) - 180 // wrap into [-180, 180)
  const latC = Math.min(Math.max(lat, -MAX_LAT), MAX_LAT)
  const x = Math.floor(((lonW + 180) / 360) * width)
  const latR = (latC * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * height)
  return { x: Math.min(Math.max(x, 0), width - 1), y: Math.min(Math.max(y, 0), height - 1) }
}

export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`
}
