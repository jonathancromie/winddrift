import type { FrameGrid } from "./frame";
import type { WorkerRequest, WorkerResponse } from "./frame.worker";

export interface FrameLoader {
  post(request: WorkerRequest): void;
  onmessage: ((response: WorkerResponse) => void) | null;
}

export interface FrameStoreOptions<T> {
  urls: string[];
  loader: FrameLoader;
  upload(grid: FrameGrid, data: Uint16Array): T;
  release(resource: T): void;
  capacity: number;
  onChange(): void;
  onError(url: string, message: string): void;
}

/**
 * Keeps a limited set of decoded frames on the GPU. Frames that are no longer wanted
 * have their downloads cancelled, so fast scrubbing doesn't queue up stale requests.
 */
export class FrameStore<T> {
  private readonly ready = new Map<number, { resource: T; grid: FrameGrid; used: number }>();
  private readonly pending = new Set<number>();
  private readonly indexByUrl = new Map<string, number>();
  private wanted = new Set<number>();
  private clock = 0;

  constructor(private readonly options: FrameStoreOptions<T>) {
    options.urls.forEach((url, index) => this.indexByUrl.set(url, index));
    options.loader.onmessage = (response) => this.handle(response);
  }

  /** Declare which frames are needed now, most important first. Others stop downloading. */
  request(indices: number[]): void {
    this.wanted = new Set(indices);
    for (const index of [...this.pending]) {
      if (!this.wanted.has(index)) {
        this.pending.delete(index);
        this.options.loader.post({ type: "cancel", url: this.options.urls[index] });
      }
    }
    for (const index of indices) {
      const entry = this.ready.get(index);
      if (entry) {
        entry.used = ++this.clock;
      } else if (!this.pending.has(index)) {
        this.pending.add(index);
        this.options.loader.post({ type: "load", url: this.options.urls[index] });
      }
    }
  }

  isReady(index: number): boolean {
    return this.ready.has(index);
  }

  get(index: number): { resource: T; grid: FrameGrid } | undefined {
    return this.ready.get(index);
  }

  /** The loaded frame closest to `index`, used as a stand-in during scrubbing. */
  nearestReady(index: number): number | undefined {
    let best: number | undefined;
    for (const candidate of this.ready.keys()) {
      if (best === undefined || Math.abs(candidate - index) < Math.abs(best - index)) {
        best = candidate;
      }
    }
    return best;
  }

  get size(): number {
    return this.ready.size;
  }

  private handle(response: WorkerResponse): void {
    const index = this.indexByUrl.get(response.url);
    if (index === undefined) return;
    this.pending.delete(index);
    if (response.type === "failed") {
      this.options.onError(response.url, response.message);
      return;
    }
    if (this.ready.has(index)) return;
    const resource = this.options.upload(response.grid, response.data);
    this.ready.set(index, { resource, grid: response.grid, used: ++this.clock });
    this.evict();
    this.options.onChange();
  }

  private evict(): void {
    while (this.ready.size > this.options.capacity) {
      let oldest: number | undefined;
      let oldestUse = Infinity;
      for (const [index, entry] of this.ready) {
        if (!this.wanted.has(index) && entry.used < oldestUse) {
          oldest = index;
          oldestUse = entry.used;
        }
      }
      if (oldest === undefined) return;
      this.options.release(this.ready.get(oldest)!.resource);
      this.ready.delete(oldest);
    }
  }
}
