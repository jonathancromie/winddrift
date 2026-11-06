# WindDrift

Animated wind particles over a map, with a timeline running from recent days through the forecast.

**Live at https://winddrift.joncromie.workers.dev**

HRRR wind over the US is blended into global GFS, with fresh data four times a day. Click the map to release a smoke or pollen tracer.

## Run it

You need [uv](https://docs.astral.sh/uv/), Node, and npm 11 (npm 10.9 crashes installing these dependencies, so use `npx npm@11` if needed).

```sh
# 1. Build wind frames: 3 days of past plus the latest forecasts, about 300 MB.
#    A rerun resumes where it stopped, and removes frames that have aged out.
cd pipeline
uv run python -m winddrift.build --past-days 3

# 2. Start the app at http://localhost:5173
cd ../web
npx npm@11 install
npm run dev
```

Add `?debug` to the URL to show the frame rate and particle count, and `&particles=100000` to force a particle count.

For the showcase events and sea breeze loops, also run `uv run python -m winddrift.views` from `pipeline/` (about 440 MB).

## Tests

```sh
cd pipeline && uv run pytest
cd web && npm test && npm run build
```

## Layout

- `pipeline/winddrift/`: fetches NOAA GRIB data, regrids it, and encodes frames.
- `pipeline/spike/`: one-off checks behind the format choice, and a comparison against airport observations.
- `web/src/data/`: frame decoding, the manifest, and the texture store.
- `web/src/render/`: the MapLibre particle layer and shaders.
- `web/src/timeline/`: playback logic.
- `web/src/tracer/`: the plume integrator, its worker, and its map layer.
- `web/worker/`: the Cloudflare Worker that serves wind data from R2.

## Hosting

One Cloudflare Worker serves the site as static files and streams `/data/*` from a private R2 bucket, `winddrift-data`.

- `.github/workflows/deploy.yml` tests every push and pull request, and deploys from `main`.
- `.github/workflows/ingest.yml` publishes new frames four times a day. Run it by hand to choose how many days of history to keep.
- `.github/workflows/views.yml` publishes the showcase views in `pipeline/winddrift/views.py`. Run it by hand after adding or editing a view.

They need these GitHub Actions secrets:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | A token using the "Edit Cloudflare Workers" template |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 token with Object Read & Write on `winddrift-data` |

To try the production setup locally, build the site, upload frames with `wrangler r2 object put --local`, and run `npx wrangler dev --local`.

## Data

- Wind: [NOAA GFS](https://registry.opendata.aws/noaa-gfs-bdp-pds/) and [HRRR](https://registry.opendata.aws/noaa-hrrr-pds/).
- Basemap: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data from OpenStreetMap.
- Terrain: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/).

WindDrift shows 10 m model wind for illustration. Don't use it for safety decisions.
