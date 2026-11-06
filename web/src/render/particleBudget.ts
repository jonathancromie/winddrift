const MIN_PARTICLES = 5000;
const SLOW_FRAME_MS = 22;
const FAST_FRAME_MS = 18;
const SMOOTHING_MS = 300;
/** Longer gaps, such as a backgrounded tab, say nothing about drawing cost. */
const IGNORE_GAP_MS = 250;
const SUSTAINED_SLOW_MS = 1000;
const TRIAL_MS = 1500;
const TRIAL_CUT = 0.75;
/** A trial must shorten frames by at least this factor to count as helping. */
const MEANINGFUL_IMPROVEMENT = 0.9;
const COOLDOWN_AFTER_FAILED_TRIAL_MS = 60_000;
const GROW_AFTER_FAST_MS = 2000;
const GROWTH = 1.1;
const HOLD_GROWTH_AFTER_CUT_MS = 10_000;

/**
 * Decides how many particles to draw from how long frames take.
 *
 * Slow frames don't prove particles are the problem: browsers cap frame rates to save
 * battery, and some displays run at 30 Hz. So each cut is a trial. It stays only if
 * frames actually get faster, and otherwise the count goes back.
 */
export class ParticleBudget {
  /** Smoothed time per frame. */
  frameMs = 16;

  private limit: number;
  private readonly floor: number;
  private trial: { before: number; baselineMs: number; elapsedMs: number } | null = null;
  private slowMs = 0;
  private fastMs = 0;
  private cooldownMs = 0;
  private holdGrowthMs = 0;

  constructor(private readonly capacity: number) {
    this.limit = capacity;
    this.floor = Math.min(MIN_PARTICLES, capacity);
  }

  /** Record one frame, and return the number of particles to draw. */
  update(elapsedMs: number, wanted: number): number {
    if (elapsedMs <= IGNORE_GAP_MS) this.observe(elapsedMs, wanted);
    return this.count(wanted);
  }

  private count(wanted: number): number {
    return Math.max(this.floor, Math.min(this.limit, wanted));
  }

  private observe(elapsedMs: number, wanted: number): void {
    this.frameMs += (elapsedMs - this.frameMs) * (1 - Math.exp(-elapsedMs / SMOOTHING_MS));
    this.cooldownMs = Math.max(0, this.cooldownMs - elapsedMs);
    this.holdGrowthMs = Math.max(0, this.holdGrowthMs - elapsedMs);

    if (this.trial) {
      this.trial.elapsedMs += elapsedMs;
      if (this.trial.elapsedMs >= TRIAL_MS) this.finishTrial();
      return;
    }

    this.slowMs = this.frameMs > SLOW_FRAME_MS ? this.slowMs + elapsedMs : 0;
    this.fastMs = this.frameMs < FAST_FRAME_MS ? this.fastMs + elapsedMs : 0;

    const current = this.count(wanted);
    if (this.slowMs >= SUSTAINED_SLOW_MS && this.cooldownMs === 0 && current > this.floor) {
      this.trial = { before: this.limit, baselineMs: this.frameMs, elapsedMs: 0 };
      this.limit = Math.max(this.floor, Math.floor(current * TRIAL_CUT));
      this.slowMs = 0;
    } else if (this.fastMs >= GROW_AFTER_FAST_MS && this.holdGrowthMs === 0) {
      this.limit = Math.min(this.capacity, Math.ceil(this.limit * GROWTH));
      this.fastMs = 0;
    }
  }

  private finishTrial(): void {
    const { before, baselineMs } = this.trial!;
    this.trial = null;
    if (this.frameMs < baselineMs * MEANINGFUL_IMPROVEMENT) {
      this.holdGrowthMs = HOLD_GROWTH_AFTER_CUT_MS;
    } else {
      this.limit = before;
      this.cooldownMs = COOLDOWN_AFTER_FAILED_TRIAL_MS;
    }
  }
}
