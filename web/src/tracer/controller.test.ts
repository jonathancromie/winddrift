import { describe, expect, it } from "vitest";
import { formatPlace, releaseEnd, splitAtAntimeridian } from "./controller";

const HOUR = 3600 * 1000;

describe("formatPlace", () => {
  it("labels each hemisphere", () => {
    expect(formatPlace(-118.25, 34.05)).toBe("34.05°N, 118.25°W");
    expect(formatPlace(151.2, -33.87)).toBe("33.87°S, 151.20°E");
  });
});

describe("releaseEnd", () => {
  it("runs for 72 hours", () => {
    expect(releaseEnd(0, 100 * HOUR)).toBe(72 * HOUR);
  });

  it("stops early when the wind data ends first", () => {
    expect(releaseEnd(0, 40 * HOUR)).toBe(40 * HOUR);
  });
});

describe("splitAtAntimeridian", () => {
  it("leaves an ordinary path whole", () => {
    expect(splitAtAntimeridian([[0, 0], [1, 1], [2, 2]])).toHaveLength(1);
  });

  it("splits where longitude jumps", () => {
    const lines = splitAtAntimeridian([[178, 0], [179, 0], [-179, 0], [-178, 0]]);
    expect(lines).toEqual([
      [[178, 0], [179, 0]],
      [[-179, 0], [-178, 0]],
    ]);
  });

  it("drops a lone point left on either side of a jump", () => {
    expect(splitAtAntimeridian([[179, 0], [-179, 0], [-178, 0]])).toEqual([[[-179, 0], [-178, 0]]]);
  });
});
