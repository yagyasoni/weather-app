import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SAMPLE_ROOT = REPO / "web" / "public" / "data" / "sample"


def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", default=False,
                     help="run tests that download data from ECMWF Open Data and Open-Meteo")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="needs network; run with --live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def sample_root() -> Path:
    if not (SAMPLE_ROOT / "latest.json").exists():
        pytest.skip("no sample run checked in under web/public/data/sample")
    return SAMPLE_ROOT


@pytest.fixture(scope="session")
def sample(sample_root):
    """(latest.json, run directory, manifest) for the checked-in sample run."""
    latest = json.loads((sample_root / "latest.json").read_text())
    run_dir = sample_root / latest["run_id"]
    manifest = json.loads((run_dir / "manifest.json").read_text())
    return latest, run_dir, manifest
