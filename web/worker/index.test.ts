import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest, keyForPath, type Env } from "./index";

const FRAME = "hrrr/2026110518/f012.wdf";

function bucketWith(objects: Record<string, string>) {
  const reads: string[] = [];
  const env: Env = {
    WIND_DATA: {
      async get(key) {
        reads.push(key);
        if (!(key in objects)) return null;
        return { body: new Blob([objects[key]]).stream(), httpEtag: `"etag-${key}"`, size: objects[key].length };
      },
    },
  };
  return { env, reads };
}

function memoryCache() {
  const stored = new Map<string, Response>();
  return {
    stored,
    async match(request: Request) {
      return stored.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      stored.set(request.url, response);
    },
  };
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
}

const request = (path: string, method = "GET") => new Request(`https://example.test${path}`, { method });

describe("keyForPath", () => {
  it.each([
    ["/data/manifest.json", "manifest.json"],
    ["/data/gfs/2026110518/f240.wdf", "gfs/2026110518/f240.wdf"],
    ["/data/hrrr/2026110518/f000.wdf", "hrrr/2026110518/f000.wdf"],
    ["/data/views/index.json", "views/index.json"],
    ["/data/views/la-fires/manifest.json", "views/la-fires/manifest.json"],
    ["/data/views/la-fires/hrrr/2025010612/f000.wdf", "views/la-fires/hrrr/2025010612/f000.wdf"],
  ])("serves %s", (path, key) => {
    expect(keyForPath(path)).toBe(key);
  });

  it.each([
    "/",
    "/data/",
    "/data",
    "/manifest.json",
    "/data/../secret",
    "/data/gfs/../../secret.wdf",
    "/data/secret.json",
    "/data/rrfs/2026110518/f000.wdf",
    "/data/gfs/20261105/f000.wdf",
    "/data/gfs/2026110518/f0000.wdf",
    "/data/gfs/2026110518/f000.wdf/extra",
    "/data/manifest.json.bak",
    "/data/views/",
    "/data/views/secret.json",
    "/data/views/../manifest.json",
    "/data/views/a/b/manifest.json",
    "/data/views/UPPER/manifest.json",
    "/data/views/la-fires/secret.wdf",
    "/data/views/la-fires/rrfs/2025010612/f000.wdf",
  ])("refuses %s", (path) => {
    expect(keyForPath(path)).toBeNull();
  });
});

describe("handleRequest", () => {
  let cache: ReturnType<typeof memoryCache>;

  beforeEach(() => {
    cache = memoryCache();
  });

  it("serves a frame with permanent caching", async () => {
    const { env } = bucketWith({ [FRAME]: "wind" });
    const response = await handleRequest(request(`/data/${FRAME}`), env, context(), cache);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("wind");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("etag")).toBe(`"etag-${FRAME}"`);
  });

  it("serves the manifest with short caching, so new runs appear quickly", async () => {
    const { env } = bucketWith({ "manifest.json": "{}" });
    const response = await handleRequest(request("/data/manifest.json"), env, context(), cache);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("gives view listings short caching and view frames permanent caching", async () => {
    const frame = "views/helene/gfs/2024092512/f000.wdf";
    const { env } = bucketWith({ "views/helene/manifest.json": "{}", [frame]: "wind" });
    const listing = await handleRequest(request("/data/views/helene/manifest.json"), env, context(), memoryCache());
    expect(listing.headers.get("cache-control")).toBe("public, max-age=300");
    expect(listing.headers.get("content-type")).toBe("application/json");
    const viewFrame = await handleRequest(request(`/data/${frame}`), env, context(), memoryCache());
    expect(viewFrame.headers.get("cache-control")).toContain("immutable");
  });

  it("answers a second request from the cache without reading the bucket", async () => {
    const { env, reads } = bucketWith({ [FRAME]: "wind" });
    const first = context();
    await handleRequest(request(`/data/${FRAME}`), env, first, cache);
    await Promise.all(first.pending);
    const response = await handleRequest(request(`/data/${FRAME}`), env, context(), cache);
    expect(await response.text()).toBe("wind");
    expect(reads).toHaveLength(1);
  });

  it("returns 404 for a frame that isn't there, and doesn't cache it", async () => {
    const { env } = bucketWith({});
    const response = await handleRequest(request(`/data/${FRAME}`), env, context(), cache);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.stored.size).toBe(0);
  });

  it("never reads the bucket for a path it doesn't serve", async () => {
    const { env, reads } = bucketWith({ secret: "x" });
    const response = await handleRequest(request("/data/secret"), env, context(), cache);
    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("refuses writes", async () => {
    const { env, reads } = bucketWith({ [FRAME]: "wind" });
    const response = await handleRequest(request(`/data/${FRAME}`, "DELETE"), env, context(), cache);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(reads).toEqual([]);
  });

  it("answers HEAD with headers and no body", async () => {
    const { env } = bucketWith({ [FRAME]: "wind" });
    const response = await handleRequest(request(`/data/${FRAME}`, "HEAD"), env, context(), cache);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("");
    expect(cache.stored.size).toBe(0);
  });
});
