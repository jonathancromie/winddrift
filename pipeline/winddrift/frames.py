"""Choose which model frames make up the timeline.

The past comes from the short-range start of each older run, which is the closest a
model gets to what actually happened. The future comes from one recent long run.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass(frozen=True)
class FrameSpec:
    model: str
    cycle: datetime
    fxx: int

    @property
    def valid(self) -> datetime:
        return self.cycle + timedelta(hours=self.fxx)

    @property
    def relative_path(self) -> str:
        return f"{self.model}/{self.cycle:%Y%m%d%H}/f{self.fxx:03d}.wdf"


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
