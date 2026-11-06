import { beforeEach, describe, expect, it } from "vitest";
import type { FrameGrid } from "./frame";
import type { WorkerRequest, WorkerResponse } from "./frame.worker";
import { FrameStore, type FrameLoader } from "./frameStore";

const grid: FrameGrid = { nx: 1, ny: 1, lon0: 0, lat0: 0, dlon: 1, dlat: 1 };

class FakeLoader implements FrameLoader {
  posts: WorkerRequest[] = [];
  onmessage: ((response: WorkerResponse) => void) | null = null;
  post(request: WorkerRequest) {
    this.posts.push(request);
  }
  deliver(url: string) {
    this.onmessage!({ type: "loaded", url, grid, data: new Uint16Array(2) });
  }
  fail(url: string) {
    this.onmessage!({ type: "failed", url, message: "boom" });
  }
}

describe("FrameStore", () => {
  let loader: FakeLoader;
  let released: string[];
  let errors: string[];
  let changes: number;
  let store: FrameStore<string>;
  let uploads: number;

  beforeEach(() => {
    loader = new FakeLoader();
    released = [];
    errors = [];
    changes = 0;
    uploads = 0;
    store = new FrameStore<string>({
      urls: ["f0", "f1", "f2", "f3", "f4"],
      loader,
      upload: () => `tex${uploads++}`,
      release: (resource) => released.push(resource),
      capacity: 2,
      onChange: () => changes++,
      onError: (url) => errors.push(url),
    });
  });

  it("loads each frame once", () => {
    store.request([0, 1]);
    store.request([0, 1]);
    expect(loader.posts).toEqual([
      { type: "load", url: "f0" },
      { type: "load", url: "f1" },
    ]);
  });

  it("cancels downloads that are no longer wanted", () => {
    store.request([0, 1]);
    store.request([1, 2]);
    expect(loader.posts).toContainEqual({ type: "cancel", url: "f0" });
    expect(loader.posts).not.toContainEqual({ type: "cancel", url: "f1" });
  });

  it("can request a cancelled frame again", () => {
    store.request([0]);
    store.request([1]);
    store.request([0]);
    expect(loader.posts.filter((p) => p.type === "load" && p.url === "f0")).toHaveLength(2);
  });

  it("uploads delivered frames and reports the change", () => {
    store.request([0]);
    loader.deliver("f0");
    expect(store.isReady(0)).toBe(true);
    expect(store.get(0)?.resource).toBe("tex0");
    expect(changes).toBe(1);
  });

  it("evicts the least recently used frame that is not wanted", () => {
    store.request([0]);
    loader.deliver("f0");
    store.request([1]);
    loader.deliver("f1");
    store.request([2]);
    loader.deliver("f2");
    expect(released).toEqual(["tex0"]);
    expect(store.isReady(0)).toBe(false);
    expect(store.size).toBe(2);
  });

  it("never evicts wanted frames, even over capacity", () => {
    store.request([0, 1, 2]);
    loader.deliver("f0");
    loader.deliver("f1");
    loader.deliver("f2");
    expect(released).toEqual([]);
    expect(store.size).toBe(3);
  });

  it("finds the nearest loaded frame", () => {
    expect(store.nearestReady(2)).toBeUndefined();
    store.request([0, 4]);
    loader.deliver("f0");
    loader.deliver("f4");
    expect(store.nearestReady(1)).toBe(0);
    expect(store.nearestReady(3)).toBe(4);
  });

  it("passes along an edge mask that arrives with a frame", () => {
    const masks: Uint8Array[] = [];
    const withMask = new FrameStore<string>({
      urls: ["f0"],
      loader,
      upload: () => "tex",
      release: () => {},
      onMask: (_, mask) => masks.push(mask),
      capacity: 2,
      onChange: () => {},
      onError: () => {},
    });
    withMask.request([0]);
    const mask = new Uint8Array(1);
    loader.onmessage!({ type: "loaded", url: "f0", grid, data: new Uint16Array(2), mask });
    expect(masks).toEqual([mask]);
  });

  it("reports failures and allows a retry", () => {
    store.request([0]);
    loader.fail("f0");
    expect(errors).toEqual(["f0"]);
    expect(store.isReady(0)).toBe(false);
    store.request([0]);
    expect(loader.posts.filter((p) => p.type === "load")).toHaveLength(2);
  });
});
