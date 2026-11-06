"""Choose which model frames make up the timeline.

The past comes from the short-range start of each older run, which is the closest a
model gets to what actually happened. The future comes from one recent long run.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .regrid import LatLonGrid


@dataclass(frozen=True)
class FrameSpec:
    model: str
    cycle: datetime
    fxx: int
    # Where the frame is stored within the data, for frames that belong to one view.
    prefix: str = ""
    # A finer regional grid than the default, used by close-up views.
    grid: LatLonGrid | None = field(default=None, compare=False)

    @property
    def valid(self) -> datetime:
        return self.cycle + timedelta(hours=self.fxx)

    @property
    def relative_path(self) -> str:
        return f"{self.prefix}{self.model}/{self.cycle:%Y%m%d%H}/f{self.fxx:03d}.wdf"


def plan_past_hrrr(
    start: datetime, end: datetime, prefix: str = "", grid: LatLonGrid | None = None
) -> list[FrameSpec]:
    """Hourly frames for a fixed span in the past, each the start of that hour's run."""
    count = int((end - start).total_seconds() // 3600) + 1
    return [FrameSpec("hrrr", start + timedelta(hours=i), 0, prefix, grid) for i in range(count)]


def plan_past_gfs(start: datetime, end: datetime, prefix: str = "") -> list[FrameSpec]:
    """3-hourly frames for a fixed span in the past, widened to cover both ends."""
    first = start.replace(hour=start.hour - start.hour % 3, minute=0, second=0, microsecond=0)
    specs = []
    valid = first
    while True:
        offset = valid.hour % 6
        specs.append(FrameSpec("gfs", valid - timedelta(hours=offset), offset, prefix))
        if valid >= end:
            return specs
        valid += timedelta(hours=3)


def plan_hrrr(long_cycle: datetime, past_days: int, forecast_hours: int) -> list[FrameSpec]:
    """Hourly: the start of every hourly run in the past, then the long run's forecast."""
    specs = []
    cycle = long_cycle - timedelta(days=past_days)
    while cycle < long_cycle:
        specs.append(FrameSpec("hrrr", cycle, 0))
        cycle += timedelta(hours=1)
    specs.extend(FrameSpec("hrrr", long_cycle, fxx) for fxx in range(forecast_hours + 1))
    return specs


def plan_gfs(long_cycle: datetime, past_days: int, forecast_hours: int) -> list[FrameSpec]:
    """3-hourly: hours 0 and 3 of every 6-hourly run in the past, then the long run's forecast."""
    specs = []
    cycle = long_cycle - timedelta(days=past_days)
    while cycle < long_cycle:
        specs.append(FrameSpec("gfs", cycle, 0))
        specs.append(FrameSpec("gfs", cycle, 3))
        cycle += timedelta(hours=6)
    specs.extend(FrameSpec("gfs", long_cycle, fxx) for fxx in range(0, forecast_hours + 1, 3))
    return specs


def latest_long_cycle_candidates(now: datetime, count: int = 6) -> list[datetime]:
    """The most recent 00, 06, 12 and 18Z runs at or before `now`, newest first."""
    hour = now.hour - now.hour % 6
    newest = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    return [newest - timedelta(hours=6 * i) for i in range(count)]
