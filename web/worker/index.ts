/**
 * Serves wind data from a private R2 bucket at /data/*. Everything else on the site is
 * static files, which Cloudflare serves without running this Worker.
 */

export interface StoredObject {
  body: ReadableStream;
  httpEtag: string;
  size: number;
}

export interface DataBucket {
  get(key: string): Promise<StoredObject | null>;
}

export interface Env {
  WIND_DATA: DataBucket;
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

const MANIFEST_KEY = "manifest.json";
/** Only keys the pipeline writes, so nothing else in the bucket can be reached. */
const FRAME_KEY = /^(gfs|hrrr)\/\d{10}\/f\d{3}\.wdf$/;
const DATA_PREFIX = "/data/";

const FRAME_CACHE = "public, max-age=31536000, immutable";
const MANIFEST_CACHE = "public, max-age=300";

/** The bucket key for a request path, or null if it isn't something we serve. */
export function keyForPath(pathname: string): string | null {
  if (!pathname.startsWith(DATA_PREFIX)) return null;
  const key = pathname.slice(DATA_PREFIX.length);
  return key === MANIFEST_KEY || FRAME_KEY.test(key) ? key : null;
}

function plainResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function handleRequest(
  request: Request,
  env: Env,
  context: WorkerContext,
  cache: EdgeCache,
): Promise<Response> {
  const key = keyForPath(new URL(request.url).pathname);
  if (!key) return plainResponse(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plainResponse(405, "Method not allowed", { allow: "GET, HEAD" });
  }

  // Cloudflare's cache only stores GET requests, so HEAD goes straight to the bucket.
  if (request.method === "GET") {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  const object = await env.WIND_DATA.get(key);
  if (!object) return plainResponse(404, "Not found");

  const headers = {
    "content-type": key === MANIFEST_KEY ? "application/json" : "application/octet-stream",
    "cache-control": key === MANIFEST_KEY ? MANIFEST_CACHE : FRAME_CACHE,
    "content-length": String(object.size),
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  };
  if (request.method === "HEAD") {
    void object.body.cancel();
    return new Response(null, { headers });
  }

  const response = new Response(object.body, { headers });
  context.waitUntil(cache.put(request, response.clone()));
  return response;
}

export default {
  fetch(request: Request, env: Env, context: WorkerContext): Promise<Response> {
    const { default: edgeCache } = caches as unknown as { default: EdgeCache };
    return handleRequest(request, env, context, edgeCache);
  },
};
