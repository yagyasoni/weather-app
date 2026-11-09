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
- [ ] Day 2: map, overlay, time slider and playback
- [ ] Day 3: point query, layers, legend, mobile layout
- [ ] Day 4: CI workflow, GitHub Pages deployment
