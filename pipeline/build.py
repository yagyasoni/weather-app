#!/usr/bin/env python3
"""
Build web-ready precipitation forecast assets from ECMWF Open Data.

For the latest available run of the configured model this script:
  1. downloads total precipitation (tp) for every forecast step,
  2. converts the accumulated field into per-interval rainfall in mm,
  3. warps each field from the 0.25 deg lat/lon grid to Web Mercator,
  4. encodes it as an 8-bit grayscale PNG "data texture" that the web
     front end both colours and reads values back from,
  5. writes manifest.json for the run and a latest.json pointer.

Usage:
  python pipeline/build.py --out web/public/data
  python pipeline/build.py --out web/public/data/sample --force
  python pipeline/build.py --date 20261109 --time 0
  python pipeline/build.py --max-steps 3            # quick smoke test
  python pipeline/build.py --print-latest           # which run would be built
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image
from ecmwf.opendata import Client

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MODEL = "aifs-single"            # "aifs-single" or "ifs"
SOURCE = "ecmwf"                 # "ecmwf", "azure" or "aws"
PARAM = "tp"
STEPS = list(range(6, 361, 6))   # hours; AIFS Single publishes 6-hourly to 360 h

WIDTH = 1440                     # Web Mercator world is square
HEIGHT = 1440
MAX_LAT = 85.05112878            # Web Mercator latitude limit

VMAX_INTERVAL_MM = 200.0         # encoding ceiling for per-interval rainfall (tropical cyclones exceed 100)
VMAX_ACC_MM = 500.0              # encoding ceiling for accumulation layers
ACC_HOURS = [24, 72, 240]        # accumulation layers to publish
FIRST_RAIN_THRESHOLD_MM = 1.0    # "first rain" layer: first interval above this

KEEP_RUNS = 2                    # run folders to retain in the output root
ATTRIBUTION = "Forecast data: ECMWF Open Data, licensed CC BY 4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"

RUN_DIR_RE = re.compile(r"^\d{10}$")

# Factor that converts the GRIB's native unit into millimetres. IFS publishes
# tp in metres; AIFS publishes it in kg m**-2, which is numerically mm.
UNIT_TO_MM = {"m": 1000.0, "mm": 1.0, "kg m**-2": 1.0, "kg m-2": 1.0}


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {msg}", flush=True)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# ECMWF Open Data access
# ---------------------------------------------------------------------------
def make_request(steps: list[int]) -> dict:
    return {"type": "fc", "stream": "oper", "param": PARAM, "step": steps}


def find_latest_run(client: Client, request: dict) -> datetime:
    """Most recent run for which every requested field is already published."""
    dt = client.latest(**request)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def download(client: Client, run: datetime, request: dict, target: Path) -> None:
    client.retrieve(
        date=run.strftime("%Y%m%d"),
        time=run.hour,
        target=str(target),
        **request,
    )


def load_tp(path: Path) -> xr.DataArray:
    """Open the GRIB file and normalise orientation: north->south, lon -180..180."""
    ds = xr.open_dataset(
        path,
        engine="cfgrib",
        backend_kwargs={"indexpath": "", "filter_by_keys": {"shortName": PARAM}},
    )
    da = ds[PARAM]
    if "step" not in da.dims:
        da = da.expand_dims("step")
    da = da.sortby("latitude", ascending=False)
    lon = ((da["longitude"].values + 180.0) % 360.0) - 180.0
    da = da.assign_coords(longitude=lon).sortby("longitude")
    return da


# ---------------------------------------------------------------------------
# Reprojection and encoding
# ---------------------------------------------------------------------------
def mercator_row_latitudes(height: int) -> np.ndarray:
    """Latitude of each output row centre, row 0 at the north edge."""
    y = (np.arange(height) + 0.5) / height
    return np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * y))))


def build_warp_indices(lat_src: np.ndarray, lon_src: np.ndarray, width: int, height: int):
    """Nearest-neighbour lookup tables from the lat/lon grid into a Mercator image."""
    lat_tgt = mercator_row_latitudes(height)
    rows = np.abs(lat_src[None, :] - lat_tgt[:, None]).argmin(axis=1)
    # Sample columns at their west edge so pixel j coincides with source column j at
    # native width. This matches the front end's x = floor((lon + 180) / 360 * width)
    # and avoids ties when pixel centres fall exactly between two grid columns.
    lon_tgt = -180.0 + np.arange(width) * 360.0 / width
    dlon = np.abs(((lon_src[None, :] - lon_tgt[:, None] + 180.0) % 360.0) - 180.0)
    cols = dlon.argmin(axis=1)
    return rows, cols


def unit_scale(units: str) -> float:
    try:
        return UNIT_TO_MM[units.strip()]
    except KeyError:
        raise SystemExit(f"unexpected units for {PARAM}: {units!r}; add it to UNIT_TO_MM") from None


def warp(field: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    return field[rows[:, None], cols[None, :]]


def encode_sqrt(mm: np.ndarray, vmax: float) -> np.ndarray:
    """mm -> uint8 with square-root stretch: g = 255 * sqrt(min(v, vmax) / vmax)."""
    g = np.sqrt(np.clip(mm, 0.0, vmax) / vmax) * 255.0
    return np.rint(g).astype(np.uint8)


def write_png(arr: np.ndarray, path: Path) -> None:
    Image.fromarray(arr, mode="L").save(path, optimize=True)


# ---------------------------------------------------------------------------
# Output management
# ---------------------------------------------------------------------------
def current_run_id(out_root: Path) -> str | None:
    p = out_root / "latest.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text()).get("run_id")
    except (OSError, ValueError):
        return None


def prune_old_runs(out_root: Path, keep: int) -> None:
    runs = sorted(d for d in out_root.iterdir() if d.is_dir() and RUN_DIR_RE.match(d.name))
    for d in runs[:-keep] if keep > 0 else runs:
        log(f"removing old run {d.name}")
        shutil.rmtree(d)


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------
def build(out_root: Path, run: datetime, grib: Path, generated_at: datetime) -> dict:
    da = load_tp(grib)
    step_hours = (da["step"].values / np.timedelta64(1, "h")).astype(int)
    lat = da["latitude"].values.astype(np.float64)
    lon = da["longitude"].values.astype(np.float64)
    log(f"grid {lat.size} x {lon.size}, {step_hours.size} steps "
        f"({step_hours.min()}h to {step_hours.max()}h), lon {lon.min():.2f}..{lon.max():.2f}")

    units = str(da.attrs.get("units") or da.attrs.get("GRIB_units") or "")
    scale = unit_scale(units)
    log(f"source units {units!r}; scaling by {scale:g} to mm")

    rows, cols = build_warp_indices(lat, lon, WIDTH, HEIGHT)

    rid = run.strftime("%Y%m%d%H")
    tmp_dir = out_root / f".{rid}.tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)

    prev_acc = np.zeros((lat.size, lon.size), dtype=np.float32)
    prev_h = 0
    first_idx = np.zeros((lat.size, lon.size), dtype=np.uint8)
    frames: list[dict] = []
    acc_frames: list[dict] = []

    for i, h in enumerate(step_hours):
        h = int(h)
        raw = da.isel(step=i).values.astype(np.float32)
        acc_mm = np.clip(np.nan_to_num(raw, nan=0.0), 0.0, None) * np.float32(scale)
        inc_mm = np.clip(acc_mm - prev_acc, 0.0, None)

        newly_wet = (first_idx == 0) & (inc_mm > FIRST_RAIN_THRESHOLD_MM)
        first_idx[newly_wet] = i + 1

        fname = f"tp_{h:03d}.png"
        write_png(encode_sqrt(warp(inc_mm, rows, cols), VMAX_INTERVAL_MM), tmp_dir / fname)
        frames.append({
            "step": h,
            "interval_hours": h - prev_h,
            "valid_time": iso(run + timedelta(hours=h)),
            "file": fname,
            "max_mm": round(float(inc_mm.max()), 2),
        })

        if h in ACC_HOURS:
            aname = f"acc_{h:03d}.png"
            write_png(encode_sqrt(warp(acc_mm, rows, cols), VMAX_ACC_MM), tmp_dir / aname)
            acc_frames.append({
                "hours": h,
                "valid_time": iso(run + timedelta(hours=h)),
                "file": aname,
                "max_mm": round(float(acc_mm.max()), 2),
            })

        prev_acc, prev_h = acc_mm, h
        if (i + 1) % 10 == 0 or i + 1 == step_hours.size:
            log(f"  wrote {i + 1}/{step_hours.size} frames")

    write_png(warp(first_idx, rows, cols), tmp_dir / "first_rain.png")

    manifest = {
        "model": MODEL,
        "source": SOURCE,
        "run": iso(run),
        "run_id": rid,
        "generated_at": iso(generated_at),
        "parameter": {"name": PARAM, "description": "Total precipitation", "units": "mm",
                      "source_units": units},
        "grid": {"resolution_deg": round(float(abs(lat[1] - lat[0])), 4)},
        "image": {
            "width": WIDTH,
            "height": HEIGHT,
            "projection": "EPSG:3857",
            "bounds": {"west": -180.0, "east": 180.0, "north": MAX_LAT, "south": -MAX_LAT},
        },
        "layers": {
            "interval": {
                "description": "Precipitation accumulated over the preceding interval",
                "encoding": {"type": "sqrt", "vmax": VMAX_INTERVAL_MM, "units": "mm",
                             "decode": "mm = (g / 255)^2 * vmax"},
                "frames": frames,
            },
            "accumulation": {
                "description": "Precipitation accumulated since the start of the forecast",
                "encoding": {"type": "sqrt", "vmax": VMAX_ACC_MM, "units": "mm",
                             "decode": "mm = (g / 255)^2 * vmax"},
                "frames": acc_frames,
            },
            "first_rain": {
                "description": f"Index of the first interval with more than "
                               f"{FIRST_RAIN_THRESHOLD_MM:g} mm; 0 means none within the forecast",
                "encoding": {"type": "index", "threshold_mm": FIRST_RAIN_THRESHOLD_MM,
                             "none_value": 0, "steps": [int(h) for h in step_hours],
                             "decode": "hours = steps[g - 1] when g > 0"},
                "file": "first_rain.png",
            },
        },
        "attribution": ATTRIBUTION,
        "license_url": LICENSE_URL,
    }
    (tmp_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    run_dir = out_root / rid
    if run_dir.exists():
        shutil.rmtree(run_dir)
    tmp_dir.rename(run_dir)

    latest = {
        "run_id": rid,
        "run": iso(run),
        "model": MODEL,
        "generated_at": iso(generated_at),
        "manifest": f"{rid}/manifest.json",
    }
    (out_root / "latest.json").write_text(json.dumps(latest, indent=2))
    return manifest


def main(argv: list[str] | None = None) -> int:
    global MODEL, SOURCE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="web/public/data", type=Path, help="output root directory")
    ap.add_argument("--model", default=MODEL, help="ECMWF Open Data model (aifs-single, ifs)")
    ap.add_argument("--source", default=SOURCE, help="ecmwf, azure or aws")
    ap.add_argument("--date", help="run date YYYYMMDD (default: latest available)")
    ap.add_argument("--time", type=int, choices=[0, 6, 12, 18], help="run hour UTC (with --date)")
    ap.add_argument("--max-steps", type=int, help="only process the first N steps (smoke test)")
    ap.add_argument("--force", action="store_true", help="rebuild even if this run already exists")
    ap.add_argument("--keep-grib", type=Path, help="keep the downloaded GRIB at this path")
    ap.add_argument("--print-latest", action="store_true",
                    help="print the id of the latest fully published run as the last line and exit")
    args = ap.parse_args(argv)

    MODEL, SOURCE = args.model, args.source

    steps = STEPS[: args.max_steps] if args.max_steps else STEPS
    request = make_request(steps)
    client = Client(source=SOURCE, model=MODEL)
    generated_at = datetime.now(timezone.utc)

    if args.date:
        if args.time is None:
            ap.error("--time is required with --date")
        run = datetime.strptime(args.date, "%Y%m%d").replace(hour=args.time, tzinfo=timezone.utc)
        log(f"using requested run {iso(run)}")
    else:
        log(f"looking up latest {MODEL} run on {SOURCE} with {len(steps)} steps of {PARAM}")
        run = find_latest_run(client, request)
        log(f"latest available run: {iso(run)}")

    if args.print_latest:
        print(run.strftime("%Y%m%d%H"))
        return 0

    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)
    rid = run.strftime("%Y%m%d%H")
    if not args.force and current_run_id(out_root) == rid and (out_root / rid / "manifest.json").exists():
        log(f"run {rid} already built in {out_root}; nothing to do")
        return 0

    with tempfile.TemporaryDirectory(prefix="ecmwf-tp-") as td:
        grib = args.keep_grib or Path(td) / f"{MODEL}_{rid}_{PARAM}.grib2"
        t0 = time.time()
        log(f"downloading {len(steps)} fields to {grib}")
        download(client, run, request, grib)
        log(f"downloaded {grib.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.0f}s")

        t0 = time.time()
        manifest = build(out_root, run, grib, generated_at)
        log(f"built run {rid} in {time.time() - t0:.0f}s")

    prune_old_runs(out_root, KEEP_RUNS)
    n_png = len(list((out_root / rid).glob("*.png")))
    size_mb = sum(p.stat().st_size for p in (out_root / rid).iterdir()) / 1e6
    log(f"done: {n_png} PNGs, {size_mb:.1f} MB in {out_root / rid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
