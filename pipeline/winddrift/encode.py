"""Binary wind frame format, read by the browser client.

Layout, little-endian:
  magic    4 bytes  b"WDF1"
  nx, ny   uint16 x 2
  lon0, lat0, dlon, dlat, scale   float32 x 5 (scale is m/s per integer step)
  payload  gzip of the filtered int16 values: all of U, then all of V

To build the payload, each row (south to north) is stored as differences from its
left neighbour, using wrapping int16 arithmetic. The bytes are then shuffled so all
low bytes precede all high bytes. Both steps help gzip on smooth fields.

Cells with no data hold NODATA in both components. Wrapping arithmetic restores them
exactly when decoding.
"""

import gzip
import struct

import numpy as np

from .regrid import LatLonGrid, WindField

MAGIC = b"WDF1"
HEADER = struct.Struct("<4sHH5f")
NODATA = -32768
DEFAULT_SCALE = 0.05


def quantize(values: np.ndarray, scale: float) -> np.ndarray:
    scaled = np.nan_to_num(np.round(values / scale), nan=NODATA)
    return np.clip(scaled, NODATA + 1, 32767).astype("<i2") * np.isfinite(values) + (
        NODATA * ~np.isfinite(values)
    ).astype("<i2")


def delta_rows(values: np.ndarray) -> np.ndarray:
    """Difference each row from its left neighbour, wrapping at the int16 limits."""
    return np.diff(values, axis=1, prepend=np.zeros((values.shape[0], 1), dtype="<i2"))


def undelta_rows(values: np.ndarray) -> np.ndarray:
    return np.cumsum(values, axis=1, dtype="<i2")


def shuffle(values: np.ndarray) -> bytes:
    raw = np.frombuffer(values.tobytes(), dtype=np.uint8)
    return raw[0::2].tobytes() + raw[1::2].tobytes()


def unshuffle(data: bytes) -> np.ndarray:
    raw = np.frombuffer(data, dtype=np.uint8)
    half = raw.size // 2
    merged = np.empty(raw.size, dtype=np.uint8)
    merged[0::2], merged[1::2] = raw[:half], raw[half:]
    return np.frombuffer(merged.tobytes(), dtype="<i2")


def encode_frame(field: WindField, scale: float = DEFAULT_SCALE, level: int = 9) -> bytes:
    grid = field.grid
    header = HEADER.pack(
        MAGIC, grid.nx, grid.ny, grid.lon0, grid.lat0, grid.dlon, grid.dlat, scale
    )
    u = delta_rows(quantize(field.u, scale))
    v = delta_rows(quantize(field.v, scale))
    # mtime=0 keeps output byte-identical for identical input.
    return header + gzip.compress(shuffle(np.concatenate([u, v], axis=None)), level, mtime=0)


def decode_frame(data: bytes) -> WindField:
    magic, nx, ny, lon0, lat0, dlon, dlat, scale = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError(f"not a wind frame: {magic!r}")
    values = unshuffle(gzip.decompress(data[HEADER.size :]))
    u = undelta_rows(values[: nx * ny].reshape(ny, nx))
    v = undelta_rows(values[nx * ny :].reshape(ny, nx))
    return WindField(
        LatLonGrid(lon0, lat0, dlon, dlat, nx, ny), _to_physical(u, scale), _to_physical(v, scale)
    )


def _to_physical(ints: np.ndarray, scale: float) -> np.ndarray:
    physical = ints.astype(np.float64) * scale
    physical[ints == NODATA] = np.nan
    return physical
