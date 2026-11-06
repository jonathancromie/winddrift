"""Showcase views: fixed replays of notable events, and sea breeze loops at higher detail.

Each view's frames live under views/<id>/ and never expire. Run from pipeline/:
  uv run python -m winddrift.views                 # to web/public/data for development
  uv run python -m winddrift.views --r2            # to R2, using environment credentials
  uv run python -m winddrift.views --only helene   # one view
"""

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

from .build import GRIB_DIR, LOCAL_OUT, publish
from .frames import FrameSpec, plan_past_gfs, plan_past_hrrr, with_temperature
from .regrid import LatLonGrid
from .store import MANIFEST_CACHE, LocalStore, R2Store, Store

INDEX_KEY = "views/index.json"
# About HRRR's native 3 km, over an area wide enough for a loop's map limits.
CLOSE_UP_CELL_DEGREES = 0.03
# The map stops this far inside a close-up grid, where the detail is at full strength.
CLOSE_UP_MARGIN_DEGREES = 1.0


def close_up_grid(lon: float, lat: float, half_lon: float = 4.0, half_lat: float = 3.0) -> LatLonGrid:
    cell = CLOSE_UP_CELL_DEGREES
    return LatLonGrid(
        round(lon - half_lon, 2),
        round(lat - half_lat, 2),
        cell,
        cell,
        int(2 * half_lon / cell) + 1,
        int(2 * half_lat / cell) + 1,
    )


@dataclass(frozen=True)
class View:
    id: str
    title: str
    group: str
    summary: str
    start: datetime
    end: datetime
    center: tuple[float, float]
    zoom: float
    time_zone: str
    # Close-up loops replace the usual regional grid with a finer one around one place.
    close_up: bool = False
    # A tracer released automatically when the view opens: lon, lat, time.
    tracer: tuple[float, float, datetime] | None = None
    # When the view opens, if not at the start of its range.
    opens_at: datetime | None = None

    @property
    def grid(self) -> LatLonGrid | None:
        return close_up_grid(*self.center) if self.close_up else None

    def specs(self) -> list[FrameSpec]:
        prefix = f"views/{self.id}/"
        return with_temperature(
            plan_past_gfs(self.start, self.end, prefix)
            + plan_past_hrrr(self.start, self.end, prefix, self.grid)
        )

    def manifest_fields(self) -> dict:
        fields = {
            "id": self.id,
            "title": self.title,
            "group": self.group,
            "summary": self.summary,
            "center": list(self.center),
            "zoom": self.zoom,
            "timeZone": self.time_zone,
            "loop": self.close_up,
            "night": self.close_up,
        }
        if self.opens_at:
            fields["opensAt"] = stamp(self.opens_at)
        if self.tracer:
            lon, lat, released = self.tracer
            fields["tracer"] = {"lon": lon, "lat": lat, "time": stamp(released)}
        grid = self.grid
        if grid:
            margin = CLOSE_UP_MARGIN_DEGREES
            west, south = grid.lon0 + margin, grid.lat0 + margin
            east = grid.lon0 + (grid.nx - 1) * grid.dlon - margin
            north = grid.lat0 + (grid.ny - 1) * grid.dlat - margin
            fields["maxBounds"] = [[round(west, 2), round(south, 2)], [round(east, 2), round(north, 2)]]
        return fields


def stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


VIEWS = [
    View(
        id="la-fires",
        title="Los Angeles fires",
        group="Events",
        summary=(
            "Santa Ana winds during the January 2025 Los Angeles fires. The tracer starts near "
            "Pacific Palisades as the Palisades Fire began."
        ),
        start=datetime(2025, 1, 6, 12),
        end=datetime(2025, 1, 10, 0),
        center=(-118.5, 34.0),
        zoom=6.5,
        time_zone="America/Los_Angeles",
        opens_at=datetime(2025, 1, 7, 18),
        tracer=(-118.54, 34.07, datetime(2025, 1, 7, 18, 30)),
    ),
    View(
        id="helene",
        title="Hurricane Helene",
        group="Events",
        summary="Hurricane Helene crossing the Gulf and moving inland over Florida and Georgia, September 2024.",
        start=datetime(2024, 9, 25, 12),
        end=datetime(2024, 9, 28, 12),
        center=(-84.0, 29.0),
        zoom=4.6,
        time_zone="America/New_York",
    ),
    View(
        id="canada-smoke",
        title="June 2023 smoke event",
        group="Events",
        summary=(
            "Surface wind over the Northeast in June 2023, when Canadian wildfire smoke reached New "
            "York. Much of that smoke travelled above the surface winds shown here."
        ),
        start=datetime(2023, 6, 5, 0),
        end=datetime(2023, 6, 8, 12),
        center=(-74.0, 44.0),
        zoom=4.8,
        time_zone="America/New_York",
    ),
    View(
        id="sea-breeze-la",
        title="Los Angeles",
        group="Sea breeze loops",
        summary="24 hours on July 16, 2026. Offshore before dawn, a sea breeze by midday, fading by night.",
        start=datetime(2026, 7, 16, 7),
        end=datetime(2026, 7, 17, 7),
        center=(-118.45, 33.9),
        zoom=8.0,
        time_zone="America/Los_Angeles",
        close_up=True,
    ),
    View(
        id="sea-breeze-tampa",
        title="Tampa Bay",
        group="Sea breeze loops",
        summary="24 hours on July 6, 2026. Off the land at dawn, a Gulf sea breeze by mid-morning, reversing by night.",
        start=datetime(2026, 7, 6, 4),
        end=datetime(2026, 7, 7, 4),
        center=(-82.6, 27.9),
        zoom=8.0,
        time_zone="America/New_York",
        close_up=True,
    ),
    View(
        id="lake-breeze-chicago",
        title="Chicago",
        group="Sea breeze loops",
        summary="24 hours on July 26, 2026. Westerly wind overnight, a lake breeze off Lake Michigan by afternoon, gone by night.",
        start=datetime(2026, 7, 26, 5),
        end=datetime(2026, 7, 27, 5),
        center=(-87.6, 41.9),
        zoom=8.0,
        time_zone="America/Chicago",
        close_up=True,
    ),
]


def index_document() -> dict:
    return {
        "views": [
            {"id": view.id, "title": view.title, "group": view.group} for view in VIEWS
        ]
    }


def publish_view(view: View, store: Store, now: datetime, workers: int) -> int:
    print(f"\n== {view.id}", flush=True)
    return publish(
        view.specs(),
        {"gfs": view.start, "hrrr": view.start},
        store,
        GRIB_DIR,
        now,
        workers,
        manifest_key=f"views/{view.id}/manifest.json",
        extra={"view": view.manifest_fields()},
        prune=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--r2", action="store_true", help="publish to R2 instead of a local folder")
    parser.add_argument("--only", help="publish one view by its id")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    store: Store = R2Store.from_environment() if args.r2 else LocalStore(LOCAL_OUT)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    chosen = [view for view in VIEWS if not args.only or view.id == args.only]
    if not chosen:
        parser.error(f"unknown view: {args.only}")
    failures = sum(publish_view(view, store, now, args.workers) for view in chosen)
    # The index goes last, so it never offers a view that isn't there yet.
    store.put(INDEX_KEY, json.dumps(index_document(), indent=1).encode(), MANIFEST_CACHE, "application/json")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
