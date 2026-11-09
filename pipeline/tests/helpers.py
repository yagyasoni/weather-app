"""Shared helpers: the decode side of the PNG encoding, as the front end will implement it."""
import math

import numpy as np
from PIL import Image


def decode(g, vmax: float):
    """Grey level 0..255 -> millimetres. Inverse of build.encode_sqrt."""
    return (np.asarray(g, dtype=np.float64) / 255.0) ** 2 * vmax


def quant_tolerance(mm, vmax: float):
    """Largest decode error the 8-bit square-root encoding can introduce at value mm.

    Rounding moves the grey level by at most 0.5, so with g = 255*sqrt(mm/vmax):
    |decode(g_rounded) - mm| <= vmax/255^2 * 0.5 * (2g + 0.5) = vmax/255^2 * (g + 0.25).
    """
    g = np.sqrt(np.clip(mm, 0.0, vmax) / vmax) * 255.0
    return vmax / 255.0 ** 2 * (g + 0.25) + 1e-9


def lonlat_to_pixel(lon: float, lat: float, width: int, height: int):
    """Forward Web Mercator from degrees to image pixel. Same formula the web app uses."""
    x = int((lon + 180.0) / 360.0 * width)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * height)
    return min(max(x, 0), width - 1), min(max(y, 0), height - 1)


def load_gray(path) -> np.ndarray:
    img = Image.open(path)
    assert img.mode == "L", f"{path.name} is mode {img.mode}, expected 8-bit grayscale"
    return np.asarray(img)
