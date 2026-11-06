import { describe, expect, it } from "vitest";
import { ParticleBudget } from "./particleBudget";

const WANTED = 48_000;

/** Run for a span of simulated time, where frameCost gives frame time for a particle count. */
function run(
  budget: ParticleBudget,
  seconds: number,
  frameCost: (particles: number) => number,
  wanted = WANTED,
  start = wanted,
): { last: number; lowest: number } {
  let particles = start;
  let lowest = start;
  let elapsed = 0;
  while (elapsed < seconds * 1000) {
    const frame = frameCost(particles);
    particles = budget.update(frame, wanted);
    lowest = Math.min(lowest, particles);
    elapsed += frame;
  }
  return { last: particles, lowest };
}

describe("ParticleBudget", () => {
  it("draws the wanted count when frames are fast", () => {
    const budget = new ParticleBudget(100_000);
    expect(run(budget, 10, () => 8.3).last).toBe(WANTED);
  });

  it("keeps the count under a frame-rate cap that particles can't affect", () => {
    const budget = new ParticleBudget(100_000);
    const { last } = run(budget, 30, () => 33.3);
    expect(last).toBe(WANTED);
  });

  it("only dips briefly, by one trial, under a cap", () => {
    const budget = new ParticleBudget(100_000);
    const { lowest } = run(budget, 30, () => 33.3);
    expect(lowest).toBe(Math.floor(WANTED * 0.75));
  });

  it("waits a long time before testing a cap again", () => {
    const budget = new ParticleBudget(100_000);
    run(budget, 10, () => 33.3);
    expect(run(budget, 30, () => 33.3).lowest).toBe(WANTED);
  });

  it("cuts particles when they really are the cost", () => {
    const budget = new ParticleBudget(100_000);
    // A weak GPU: frame time is proportional to particles, 60 fps at about 16,000.
    const { last } = run(budget, 60, (particles) => Math.max(8.3, particles / 1000));
    expect(last).toBeLessThan(24_000);
    expect(last).toBeGreaterThan(10_000);
  });

  it("settles without falling to the floor on a weak GPU", () => {
    const budget = new ParticleBudget(100_000);
    const { lowest } = run(budget, 120, (particles) => Math.max(8.3, particles / 1000));
    expect(lowest).toBeGreaterThan(10_000);
  });

  it("grows back when the device has room again", () => {
    const budget = new ParticleBudget(100_000);
    const reduced = run(budget, 30, (particles) => Math.max(8.3, particles / 1000)).last;
    expect(reduced).toBeLessThan(WANTED);
    expect(run(budget, 60, () => 8.3, WANTED, reduced).last).toBe(WANTED);
  });

  it("ignores long gaps such as a backgrounded tab", () => {
    const budget = new ParticleBudget(100_000);
    for (let i = 0; i < 100; i++) budget.update(5000, WANTED);
    expect(budget.update(8.3, WANTED)).toBe(WANTED);
    expect(budget.frameMs).toBeLessThan(20);
  });

  it("never exceeds the capacity or drops below the floor", () => {
    const small = new ParticleBudget(3000);
    expect(small.update(8.3, 48_000)).toBe(3000);
    const budget = new ParticleBudget(100_000);
    expect(budget.update(8.3, 100)).toBe(5000);
  });
});
