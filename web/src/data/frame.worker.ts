import { decodeFrame, toHalfFloatRG } from "./frame";

export type WorkerRequest = { type: "load"; url: string } | { type: "cancel"; url: string };

export type WorkerResponse =
  | { type: "loaded"; url: string; grid: import("./frame").FrameGrid; data: Uint16Array }
  | { type: "failed"; url: string; message: string };

const inFlight = new Map<string, AbortController>();

async function load(url: string): Promise<void> {
  const controller = new AbortController();
  inFlight.set(url, controller);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const frame = await decodeFrame(await response.arrayBuffer());
    if (controller.signal.aborted) return;
    const data = toHalfFloatRG(frame);
    const message: WorkerResponse = { type: "loaded", url, grid: frame.grid, data };
    self.postMessage(message, { transfer: [data.buffer] });
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
