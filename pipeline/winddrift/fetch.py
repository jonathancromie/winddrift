"""Download only the 10 m U/V messages from NOAA GRIB2 files using byte ranges."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
from eccodes import (
    codes_get,
    codes_get_values,
    codes_grib_new_from_file,
    codes_release,
)
from herbie import Herbie

WIND_10M_SEARCH = r":[UV]GRD:10 m above ground"


@dataclass
class RawWind:
    """U/V on the source grid, plus the GRIB metadata needed to interpret them."""

    u: np.ndarray
    v: np.ndarray
    nx: int
    ny: int
    u_v_relative_to_grid: bool
    params: dict


def fetch_subset(model: str, cycle: datetime, fxx: int, save_dir: Path) -> Path:
    """Fetch the U/V subset for one forecast hour and return the local file path."""
    product = "sfc" if model == "hrrr" else "pgrb2.0p25"
    herbie = Herbie(
        cycle.strftime("%Y-%m-%d %H:%M"),
        model=model,
        product=product,
        fxx=fxx,
        save_dir=save_dir,
        priority=["aws"],
        verbose=False,
    )
    return Path(herbie.download(WIND_10M_SEARCH, verbose=False))


def read_wind(path: Path) -> RawWind:
    """Read U and V from a two-message GRIB subset, in south-to-north GRIB scan order."""
    fields: dict[str, np.ndarray] = {}
    meta: dict = {}
    with open(path, "rb") as handle:
        while (gid := codes_grib_new_from_file(handle)) is not None:
            try:
                short_name = codes_get(gid, "shortName")
                nx = codes_get(gid, "Ni") if _has_ij(gid) else codes_get(gid, "Nx")
                ny = codes_get(gid, "Nj") if _has_ij(gid) else codes_get(gid, "Ny")
                fields[short_name] = codes_get_values(gid).reshape(ny, nx)
                meta = {
                    "nx": nx,
                    "ny": ny,
                    "relative": bool(codes_get(gid, "uvRelativeToGrid")),
                    "grid_type": codes_get(gid, "gridType"),
                    "j_scans_positively": bool(codes_get(gid, "jScansPositively")),
                    "lat_first": codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                    "lon_first": codes_get(gid, "longitudeOfFirstGridPointInDegrees"),
                }
                if meta["grid_type"] == "lambert":
                    meta.update(
                        dx=codes_get(gid, "DxInMetres"),
                        dy=codes_get(gid, "DyInMetres"),
                        lov=codes_get(gid, "LoVInDegrees"),
                        latin1=codes_get(gid, "Latin1InDegrees"),
                        latin2=codes_get(gid, "Latin2InDegrees"),
                        lad=codes_get(gid, "LaDInDegrees"),
                        radius=codes_get(gid, "radius"),
                    )
            finally:
                codes_release(gid)
    if "10u" not in fields or "10v" not in fields:
        raise ValueError(f"{path} lacks 10 m U/V, found {sorted(fields)}")
    return RawWind(
        u=fields["10u"],
        v=fields["10v"],
        nx=meta["nx"],
        ny=meta["ny"],
        u_v_relative_to_grid=meta["relative"],
        params=meta,
    )


def _has_ij(gid) -> bool:
    return codes_get(gid, "gridType") == "regular_ll"
