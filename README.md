# Precipitation Forecast App

A web application that shows the latest ECMWF precipitation forecast on an
interactive map. Built for the QUEST Lab Full Stack AI pre-doctoral
application (Project 1).

Forecast data comes from [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data)
(AIFS Single, 0.25°, 6-hourly to 360 h), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Architecture

There is no server. A scheduled Python job turns each forecast run into a
folder of small PNG "data textures" plus a JSON manifest, and a static web
page renders them.

```
ECMWF Open Data ──▶ pipeline/build.py ──▶ web/public/data/<run_id>/*.png + manifest.json
   (GRIB2, tp)        (every 6 h in CI)              │
                                                     ▼
                                          static site (MapLibre GL JS)
```

Each PNG is an 8-bit grayscale image in Web Mercator (1440 × 1440) holding
rainfall in millimetres with a square-root stretch:

```
g  = round(255 * sqrt(min(mm, vmax) / vmax))
mm = (g / 255)^2 * vmax
```

The same image is both the picture the map colours and the data the UI
reads values back from on click.

## Pipeline

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt

# build the latest available run into web/public/data
.venv/bin/python pipeline/build.py

# options
.venv/bin/python pipeline/build.py --out web/public/data/sample --force   # refresh the checked-in sample
.venv/bin/python pipeline/build.py --date 20261109 --time 6                # pin a specific run
.venv/bin/python pipeline/build.py --max-steps 3                           # quick smoke test
.venv/bin/python pipeline/build.py --source aws                            # use a cloud mirror
```

What the script does for one run:

1. Asks the `ecmwf-opendata` client for the latest run where every requested
   step of total precipitation (`tp`) is published, then downloads only
   those fields via the GRIB index byte ranges (about 20 MB).
2. Opens the GRIB with `cfgrib`, sorts latitude north to south and shifts
   longitude into -180..180.
3. Converts to millimetres using the units declared in the GRIB (IFS stores
   `tp` in metres, AIFS in kg m⁻², which is numerically mm), then differences
   consecutive steps. `tp` is accumulated since forecast start, so
   per-interval rain is `tp[i] - tp[i-1]`, clipped at zero to remove
   numerical noise.
4. Warps every field to Web Mercator with a nearest-neighbour lookup table,
   so it can be draped on a web map without distortion.
5. Writes one PNG per 6-hour interval, accumulation PNGs at 24, 72 and
   240 h, and a "hours until first rain" PNG.
6. Writes `manifest.json` (steps, valid times, encoding constants, bounds,
   attribution) and updates `latest.json`. Keeps the two newest runs.

Output layout:

```
web/public/data/
  latest.json
  2026110906/
    manifest.json
    tp_006.png … tp_360.png
    acc_024.png  acc_072.png  acc_240.png
    first_rain.png
```

`web/public/data/sample/` is one real run checked into the repo so the
front end can be developed offline. Everything else under `web/public/data/`
is generated and ignored by git.

## Web app

Static Vite + TypeScript site using MapLibre GL JS. No framework, no server.

```bash
cd web
npm install
npm run dev        # http://127.0.0.1:5173/weather-app/  (reads data/sample)
npm run build      # type-checks, then bundles into web/dist
npm run preview    # serves the production build at /weather-app/
```

How it works:

- `src/data.ts` loads `latest.json` and the manifest, then downloads frame
  PNGs a few at a time, nearest to the current frame first. Frames are decoded
  on demand into one byte per pixel and kept in a small LRU; the compressed
  blobs for all 60 frames are about 16 MB.
- `src/colormap.ts` turns grey levels into colours with a single-hue blue ramp
  on a square-root scale, transparent below 0.2 mm. The same ramp draws the
  legend, so the legend is correct by construction.
- `src/overlay.ts` paints a frame through the colour lookup table onto a
  canvas and drapes it over the map as a MapLibre canvas source in Web
  Mercator, inserted beneath the basemap's label layers.
- `src/timeline.ts` is the slider, play/pause, keyboard shortcuts (space,
  arrows, home, end), the time readout in the viewer's time zone and the
  day ticks. Static layers freeze it and replace the readout.
- `src/layers.ts` defines the selectable layers from the manifest: 6-hourly
  rain (animated), rain totals for the next 24 h, 3 days and 10 days, and
  time until rain (an orange ramp, light for soon and dark for far off).
  Each layer carries its own lookup table, legend gradient and ticks.
- `src/point.ts` and `src/narrative.ts` power the location card. A tap on
  the map reads the same pixel from all 60 frames, draws a 15-day bar chart
  of 6-hourly totals with hover tooltips, shows totals for the next 24 h,
  3 days and 15 days, and writes a rule-based sentence such as "Dry until
  Thursday afternoon, then about 8 mm over 12 hours". Tapping a bar jumps
  the timeline to that period.
- `src/state.ts` keeps layer, time and location in the URL hash, so any
  view can be shared as a link.

Layout is responsive and reflows live on resize, no reload needed. The
header and the location card share one flex container (`.dock`) that spans
from the top of the window to just above the timeline, so they are placed by
flow and cannot overlap; the card shrinks and scrolls before the header does.

- Wide and tall: header and card stack in a left column.
- Wide but under 820 px tall: they sit side by side, stopping short of the
  map buttons in the top-right corner.
- Up to 720 px wide: the header sits at the top beside the map buttons and
  collapses to its title when a location is open, the card becomes a bottom
  sheet above the timeline, and the timeline wraps to two rows.
- Short screens drop secondary text; coarse pointers get larger targets.
- The day labels under the slider measure themselves and hide whichever
  would collide at the current width.

The dev server reads the checked-in sample run. The production build reads
`data/latest.json`, which the pipeline writes in CI, and falls back to the
sample with a visible badge if that file is missing. The site is built for
the `/weather-app/` path used by GitHub Pages; set `BASE_PATH=/` to build for
a host that serves it at the root.

Basemap: Carto Dark Matter vector tiles (no API key). Data attribution to
ECMWF is shown in the map's attribution control as the licence requires.

## Tests

```bash
.venv/bin/pip install -r pipeline/requirements-dev.txt
.venv/bin/pytest              # offline, about a second
.venv/bin/pytest --live -s    # also hits ECMWF and Open-Meteo, about a minute
```

Three tiers:

- `pipeline/tests/test_functions.py` — unit tests for the pure functions:
  Mercator row latitudes, warp lookup tables (including the dateline and a
  0..360 longitude grid), the square-root encoding round trip, unit
  handling, and run pruning. It also checks that the pixel formula the
  front end uses lands on the row the pipeline wrote.
- `pipeline/tests/test_sample.py` — contract checks on the checked-in sample
  run: manifest fields, 60 frames in order with correct valid times, every
  PNG 8-bit grayscale at the declared size, decoded maxima matching the
  manifest, no saturation, plausible global mean (catches unit mistakes),
  accumulations growing with lead time, and the first-rain layer agreeing
  with the interval frames.
- `pipeline/tests/test_live.py` — marked `live`, skipped by default. Builds
  a fresh 4-step run into a temp folder, then checks 1600 random pixels
  against the source GRIB within the encoding's quantisation error, and
  compares 6-hourly totals at the wettest mid-latitude point against
  Open-Meteo's feed of the same AIFS run.

## Status

- [x] Day 1: pipeline runs end to end and writes a valid run folder
- [x] Day 2: map, overlay, time slider and playback
- [x] Day 3: point query, layers, legend, responsive layout
- [ ] Day 4: CI workflow, GitHub Pages deployment
