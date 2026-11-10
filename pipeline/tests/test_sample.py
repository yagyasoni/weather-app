"""Consistency checks on the run checked in under web/public/data/sample.

Offline. They should pass for any run the pipeline produces, so they double as
a contract for what the front end can rely on.
"""
from datetime import datetime, timedelta, timezone

import numpy as np

import build
from helpers import decode, load_gray, quant_tolerance

N_PIXELS = 3000
SEED = 1   # fixed seed: the same random pixels are checked on every run


def parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def test_latest_points_at_run(sample, sample_root):
    latest, run_dir, m = sample
    assert run_dir.is_dir()
    assert (sample_root / latest["manifest"]).exists()
    assert m["run_id"] == latest["run_id"] == run_dir.name
    assert m["run"] == latest["run"]
    assert parse(m["run"]).strftime("%Y%m%d%H") == m["run_id"]


def test_manifest_declares_units_geometry_and_attribution(sample):
    _, _, m = sample
    assert m["parameter"]["units"] == "mm"
    assert m["parameter"]["source_units"] in build.UNIT_TO_MM
    img = m["image"]
    assert (img["width"], img["height"]) == (build.WIDTH, build.HEIGHT)
    assert img["projection"] == "EPSG:3857"
    assert img["bounds"] == {"west": -180.0, "east": 180.0,
                             "north": build.MAX_LAT, "south": -build.MAX_LAT}
    assert "ECMWF" in m["attribution"] and "CC BY" in m["attribution"]


def test_interval_frames_cover_forecast_in_order(sample):
    _, run_dir, m = sample
    frames = m["layers"]["interval"]["frames"]
    run = parse(m["run"])
    assert [f["step"] for f in frames] == build.STEPS
    for f in frames:
        assert f["interval_hours"] == 6
        assert parse(f["valid_time"]) == run + timedelta(hours=f["step"])
        assert (run_dir / f["file"]).exists()


def test_every_png_is_8bit_grayscale_of_declared_size(sample):
    _, run_dir, m = sample
    pngs = sorted(run_dir.glob("*.png"))
    assert len(pngs) == len(build.STEPS) + len(build.ACC_HOURS) + 1
    for png in pngs:
        assert load_gray(png).shape == (m["image"]["height"], m["image"]["width"]), png.name


def test_interval_frames_decode_to_manifest_maxima_without_saturation(sample):
    _, run_dir, m = sample
    layer = m["layers"]["interval"]
    vmax = layer["encoding"]["vmax"]
    for f in layer["frames"]:
        a = load_gray(run_dir / f["file"])
        mm = decode(a, vmax)
        assert (a == 255).mean() < 1e-4, f"{f['file']} saturates at the encoding ceiling"
        # max_mm is the true maximum; the PNG clips at the encoding ceiling
        expected = min(f["max_mm"], vmax)
        assert abs(mm.max() - expected) <= quant_tolerance(expected, vmax) + 0.01, f["file"]
        # a unit mistake (metres vs mm) moves this by a factor of 1000
        assert 0.05 < mm.mean() < 5.0, f"{f['file']}: global mean {mm.mean():.3f} mm is implausible"


def test_accumulation_layers_grow_with_lead_time(sample):
    _, run_dir, m = sample
    layer = m["layers"]["accumulation"]
    vmax = layer["encoding"]["vmax"]
    assert [f["hours"] for f in layer["frames"]] == build.ACC_HOURS
    accs = [decode(load_gray(run_dir / f["file"]), vmax) for f in layer["frames"]]
    means = [a.mean() for a in accs]
    assert means == sorted(means)
    first_interval = m["layers"]["interval"]["frames"][0]
    first = decode(load_gray(run_dir / first_interval["file"]), m["layers"]["interval"]["encoding"]["vmax"])
    # 24 h accumulation must contain the first 6 h everywhere, allowing for quantisation
    assert np.mean(accs[0] + 1.0 >= first) > 0.999


def test_first_rain_layer_agrees_with_interval_frames(sample):
    _, run_dir, m = sample
    enc = m["layers"]["first_rain"]["encoding"]
    frames = m["layers"]["interval"]["frames"]
    vmax = m["layers"]["interval"]["encoding"]["vmax"]
    thr = enc["threshold_mm"]
    assert enc["none_value"] == 0
    assert enc["steps"] == [f["step"] for f in frames]

    first = load_gray(run_dir / m["layers"]["first_rain"]["file"])
    assert first.max() <= len(frames)

    rng = np.random.default_rng(SEED)
    ys = rng.integers(0, first.shape[0], N_PIXELS)
    xs = rng.integers(0, first.shape[1], N_PIXELS)
    idx = first[ys, xs].astype(int)
    stack = np.stack([decode(load_gray(run_dir / f["file"])[ys, xs], vmax) for f in frames])

    slack = 0.1  # quantisation near 1 mm is about 0.04 mm
    for p in range(len(ys)):
        k = idx[p]
        if k == 0:
            assert np.all(stack[:, p] <= thr + slack), f"pixel {p}: rain but first_rain says none"
        else:
            assert stack[k - 1, p] >= thr - slack, f"pixel {p}: first_rain points at a dry interval"
            assert np.all(stack[: k - 1, p] <= thr + slack), f"pixel {p}: rain before first_rain"
