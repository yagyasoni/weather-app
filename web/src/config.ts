/** Free vector basemap, no API key. Rain is drawn beneath its place labels. */
export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

/**
 * Folder (relative to the site root) holding latest.json. The dev server reads
 * the checked-in sample; production reads the folder the pipeline fills in CI.
 * Override with VITE_DATA_ROOT, e.g. VITE_DATA_ROOT=data/sample for a local preview.
 */
export const DATA_ROOT: string = import.meta.env.VITE_DATA_ROOT ?? (import.meta.env.DEV ? 'data/sample' : 'data')
export const FALLBACK_DATA_ROOT = 'data/sample'

export const PLAYBACK_MS = 450        // time each frame stays on screen during playback
export const PRELOAD_CONCURRENCY = 4  // parallel PNG downloads while preloading
export const DECODE_CACHE = 16        // decoded frames kept in memory (2 MB each)
export const STALE_AFTER_HOURS = 18   // warn when the run is older than this; scheduled CI runs can be 7-9 h apart

export const ATTRIBUTION =
  'Forecast: <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF Open Data</a> (CC BY 4.0)'
