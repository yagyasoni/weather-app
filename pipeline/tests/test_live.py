"""End-to-end checks against live data.  Run with:  pytest --live -s

Builds a fresh 4-step run from ECMWF Open Data into a temp folder, then checks
the PNGs against the source GRIB and against Open-Meteo's feed of the same model.
"""
import json
import urllib.request

import numpy as np
import pytest

import build
from helpers import decode, load_gray, lonlat_to_pixel, quant_tolerance

pytestmark = pytest.mark.live
N_STEPS = 4
N_PIXELS = 400
SEED = 2   # fixed seed: the same random pixels are checked on every run


@pytest.fixture(scope="module")
def fresh_build(tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    grib = tmp_path_factory.mktemp("grib") / "tp.grib2"
    rc = build.main(["--out", str(out), "--max-steps", str(N_STEPS), "--force", "--keep-grib", str(grib)])
    assert rc == 0
    latest = json.loads((out / "latest.json").read_text())
    run_dir = out / latest["run_id"]
    manifest = json.loads((run_dir / "manifest.json").read_text())
    return run_dir, manifest, build.load_tp(grib)


def grib_increments_mm(da) -> np.ndarray:
    """Independent re-implementation of the differencing, on the full-precision GRIB."""
    scale = build.unit_scale(str(da.attrs.get("units") or da.attrs.get("GRIB_units")))
    acc = np.clip(np.nan_to_num(da.values.astype(np.float64)), 0.0, None) * scale
    prev = np.concatenate([np.zeros_like(acc[:1]), acc[:-1]])
    return np.clip(acc - prev, 0.0, None)


def test_pngs_reproduce_grib_values(fresh_build):
    run_dir, m, da = fresh_build
    inc = grib_increments_mm(da)
    lat, lon = da["latitude"].values, da["longitude"].values
    frames = m["layers"]["interval"]["frames"]
    vmax = m["layers"]["interval"]["encoding"]["vmax"]
    assert len(frames) == N_STEPS

    row_lat = build.mercator_row_latitudes(build.HEIGHT)
    rng = np.random.default_rng(SEED)
    pts = list(zip(rng.uniform(-84, 84, N_PIXELS), rng.uniform(-180, 180, N_PIXELS)))
    worst = 0.0
    for k, f in enumerate(frames):
        png = load_gray(run_dir / f["file"])
        for la, lo in pts:
            x, y = lonlat_to_pixel(lo, la, build.WIDTH, build.HEIGHT)
            j = np.abs(lat - row_lat[y]).argmin()
            col_lon = -180.0 + x * 360.0 / build.WIDTH
            i = np.abs(((lon - col_lon + 180.0) % 360.0) - 180.0).argmin()
            truth, got = inc[k, j, i], decode(png[y, x], vmax)
            worst = max(worst, abs(got - truth))
            assert abs(got - truth) <= quant_tolerance(truth, vmax), (f["file"], la, lo, truth, got)
    print(f"\n{len(frames) * len(pts)} pixels checked, worst decode error {worst:.3f} mm")


def test_six_hour_totals_match_open_meteo(fresh_build):
    """Open-Meteo serves the same AIFS run, so 6-hourly sums at a wet point should agree."""
    run_dir, m, da = fresh_build
    if m["model"] != "aifs-single":
        pytest.skip("the Open-Meteo model id below is for AIFS Single")
    inc = grib_increments_mm(da)
    lat, lon = da["latitude"].values, da["longitude"].values

    band = (lat <= 55) & (lat >= 30)                     # wettest mid-latitude cell: real signal
    total = inc[:, band, :].sum(axis=0)
    j, i = np.unravel_index(total.argmax(), total.shape)
    la, lo = float(lat[band][j]), float(lon[i])
    ours = inc[:, band, :][:, j, i]

    url = (f"https://api.open-meteo.com/v1/forecast?latitude={la}&longitude={lo}"
           f"&hourly=precipitation&models=ecmwf_aifs025_single&forecast_days=3&timezone=UTC")
    with urllib.request.urlopen(url, timeout=30) as r:
        om = json.loads(r.read())
    times = np.array(om["hourly"]["time"], dtype="datetime64[m]")
    precip = np.array(om["hourly"]["precipitation"], dtype=float)

    run = np.datetime64(m["run"].rstrip("Z"))
    print(f"\npoint {la:.2f}N {lo:.2f}E        ours  open-meteo")
    mismatches = 0
    for k, f in enumerate(m["layers"]["interval"]["frames"]):
        t1 = run + np.timedelta64(f["step"], "h")
        t0 = t1 - np.timedelta64(f["interval_hours"], "h")
        theirs = float(np.nansum(precip[(times > t0) & (times <= t1)]))
        print(f"  {str(t0)[5:16]} -> {str(t1)[11:16]}  {ours[k]:5.1f}  {theirs:5.1f}")
        if abs(ours[k] - theirs) > max(1.5, 0.25 * ours[k]):
            mismatches += 1
    assert mismatches <= 1, (
        "6-hourly totals disagree with Open-Meteo. If ECMWF just published a new run, "
        "Open-Meteo may still serve the previous one; rerun in an hour.")
