import { decodeFrame, EDGE_FADE_CELLS, edgeFadeMask, isGlobal, toHalfFloatRG, type FrameGrid } from "./frame";

export type WorkerRequest = { type: "load"; url: string } | { type: "cancel"; url: string };

export type WorkerResponse =
  | { type: "loaded"; url: string; grid: FrameGrid; data: Uint16Array; mask?: Uint8Array }
  | { type: "failed"; url: string; message: string };

const inFlight = new Map<string, AbortController>();
let maskSent = false;

async function load(url: string): Promise<void> {
  const controller = new AbortController();
  inFlight.set(url, controller);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const frame = await decodeFrame(await response.arrayBuffer());
    if (controller.signal.aborted) return;
    const data = toHalfFloatRG(frame);
    // A model's data covers the same cells in every frame, so one mask serves them all.
    const mask = !maskSent && !isGlobal(frame.grid) ? edgeFadeMask(frame, EDGE_FADE_CELLS) : undefined;
    maskSent ||= mask !== undefined;
    const message: WorkerResponse = { type: "loaded", url, grid: frame.grid, data, mask };
    self.postMessage(message, { transfer: mask ? [data.buffer, mask.buffer] : [data.buffer] });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message: WorkerResponse = { type: "failed", url, message: String(error) };
    self.postMessage(message);
  } finally {
    if (inFlight.get(url) === controller) inFlight.delete(url);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "load") void load(request.url);
  else inFlight.get(request.url)?.abort();
};
