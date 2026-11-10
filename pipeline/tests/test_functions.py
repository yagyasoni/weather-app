"""Unit tests for the pure functions in build.py. No network, no sample data."""
import json
import math

import numpy as np
import pytest

import build
from helpers import decode, lonlat_to_pixel, quant_tolerance

LAT_SRC = np.arange(90.0, -90.01, -0.25)   # 721 rows, north to south, as cfgrib delivers
LON_SRC = np.arange(-180.0, 180.0, 0.25)   # 1440 columns
SEED = 0   # fixed seed: the same random values are tested on every run


def test_row_latitudes_span_mercator_limits_and_decrease():
    lat = build.mercator_row_latitudes(build.HEIGHT)
    assert lat.shape == (build.HEIGHT,)
    assert 85.0 < lat[0] < build.MAX_LAT
    assert np.all(np.diff(lat) < 0)
    assert np.allclose(lat, -lat[::-1])


@pytest.mark.parametrize("lat", [-80, -45, -10, 0, 23.5, 51.5, 70, 84])
def test_frontend_pixel_formula_lands_on_matching_row(lat):
    """The forward formula the web app uses must land on a row whose latitude is the input."""
    _, y = lonlat_to_pixel(0.0, lat, build.WIDTH, build.HEIGHT)
    row_lat = build.mercator_row_latitudes(build.HEIGHT)[y]
    row_span_deg = 360.0 / build.HEIGHT * math.cos(math.radians(lat))
    assert abs(row_lat - lat) <= row_span_deg


def test_warp_indices_hit_expected_source_cells():
    rows, cols = build.build_warp_indices(LAT_SRC, LON_SRC, build.WIDTH, build.HEIGHT)
    assert rows.shape == (build.HEIGHT,) and cols.shape == (build.WIDTH,)
    assert rows[0] == 20 and LAT_SRC[20] == 85.0       # 85.05N -> nearest grid row 85.0N
    assert rows[-1] == 700 and LAT_SRC[700] == -85.0   # and the mirror image in the south
    assert np.all(np.diff(rows) >= 0)                  # never steps back north
    assert np.array_equal(cols, np.arange(1440))       # 1:1 columns at native width


def test_warp_indices_wrap_dateline_for_0_to_360_grid():
    lon_0_360 = np.arange(0.0, 360.0, 0.25)
    _, cols = build.build_warp_indices(LAT_SRC, lon_0_360, build.WIDTH, build.HEIGHT)
    assert cols[0] == 720      # -180 is the 180 column of a 0..360 grid
    assert cols[720] == 0      # 0 lon is the first column


def test_warp_applies_lookup_tables():
    field = np.arange(12, dtype=float).reshape(3, 4)
    out = build.warp(field, rows=np.array([0, 2, 2]), cols=np.array([3, 0]))
    assert out.tolist() == [[3, 0], [11, 8], [11, 8]]


def test_encode_sqrt_roundtrip_within_quantisation():
    rng = np.random.default_rng(SEED)
    vmax = build.VMAX_INTERVAL_MM
    mm = rng.uniform(0.0, vmax, 10_000)
    back = decode(build.encode_sqrt(mm, vmax), vmax)
    assert np.all(np.abs(back - mm) <= quant_tolerance(mm, vmax))


def test_encode_sqrt_edges():
    g = build.encode_sqrt(np.array([-5.0, 0.0, 0.0004, 1.0, 100.0, 250.0]), vmax=100.0)
    assert g.dtype == np.uint8
    assert g[0] == 0 and g[1] == 0          # negatives and zero are dry
    assert g[2] >= 1                         # trace rain is not lost
    assert g[3] in (25, 26)                  # 1 mm = 255 * sqrt(0.01) = 25.5
    assert g[4] == 255 and g[5] == 255       # at and above the ceiling


def test_unit_scale_known_and_unknown():
    assert build.unit_scale("m") == 1000.0
    assert build.unit_scale("kg m**-2") == 1.0
    assert build.unit_scale(" mm ") == 1.0
    with pytest.raises(SystemExit):
        build.unit_scale("inches")


def test_prune_old_runs_keeps_newest_and_ignores_other_dirs(tmp_path):
    for name in ["2026110900", "2026110906", "2026110912", "sample", ".2026110918.tmp"]:
        (tmp_path / name).mkdir()
    build.prune_old_runs(tmp_path, keep=2)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        ".2026110918.tmp", "2026110906", "2026110912", "sample"]


def test_prune_never_removes_the_run_just_built(tmp_path):
    """Building an older run than the ones on disk must not delete it."""
    for name in ["2026110900", "2026111006", "2026111012"]:
        (tmp_path / name).mkdir()
    build.prune_old_runs(tmp_path, keep=2, protect="2026110900")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["2026110900", "2026111012"]


def test_current_run_id(tmp_path):
    assert build.current_run_id(tmp_path) is None
    (tmp_path / "latest.json").write_text("not json")
    assert build.current_run_id(tmp_path) is None
    (tmp_path / "latest.json").write_text(json.dumps({"run_id": "2026110906"}))
    assert build.current_run_id(tmp_path) == "2026110906"
