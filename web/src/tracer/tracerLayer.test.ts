import { describe, expect, it } from "vitest";
import type { Plume } from "./plume";
import { trailVertices } from "./tracerLayer";

function plumeOf(paths: [number, number][][], settledAt?: number[]): Plume {
  const members = paths.length;
  const capacity = paths[0].length;
  const positions = new Float32Array(members * capacity * 2);
  paths.forEach((path, m) =>
    path.forEach(([lon, lat], point) => {
      positions[(m * capacity + point) * 2] = lon;
      positions[(m * capacity + point) * 2 + 1] = lat;
    }),
  );
  return {
    members,
    capacity,
    points: capacity,
    startMs: 0,
    recordMs: 1800 * 1000,
    positions,
    settledAt: Int16Array.from(settledAt ?? paths.map(() => -1)),
  };
}

describe("trailVertices", () => {
  it("joins each member's points into segments with hours since release", () => {
    const vertices = trailVertices(plumeOf([[[0, 0], [1, 1], [2, 2]]]));
    expect(Array.from(vertices)).toEqual([0, 0, 0, 1, 1, 0.5, 1, 1, 0.5, 2, 2, 1]);
  });

  it("stops a member's trail where it settled", () => {
    const vertices = trailVertices(plumeOf([[[0, 0], [1, 1], [2, 2]]], [1]));
    expect(vertices.length).toBe(6);
  });

  it("leaves out a segment that crosses the antimeridian", () => {
    const vertices = trailVertices(plumeOf([[[179, 0], [-179, 0], [-178, 0]]]));
    expect(Array.from(vertices)).toEqual([-179, 0, 0.5, -178, 0, 1]);
  });

  it("only uses the points computed so far", () => {
    const plume = plumeOf([[[0, 0], [1, 1], [2, 2]]]);
    plume.points = 2;
    expect(trailVertices(plume).length).toBe(6);
  });
});
