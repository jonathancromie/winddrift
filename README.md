# WindDrift

Animated wind particles over a map, with a timeline running from recent days through the forecast.

Status: running locally, with HRRR over the US blended into global GFS. Tracers and public hosting aren't built yet.

## Run it

You need [uv](https://docs.astral.sh/uv/), Node, and npm 11 (npm 10.9 crashes installing these dependencies, so use `npx npm@11` if needed).

```sh
# 1. Build wind frames: 3 days of past plus the latest forecasts, about 300 MB.
#    A rerun resumes where it stopped, and removes frames that have aged out.
cd pipeline
uv run python -m winddrift.build_local --past-days 3

# 2. Start the app at http://localhost:5173
cd ../web
npx npm@11 install
npm run dev
```

Add `?debug` to the URL to show the frame rate and particle count, and `&particles=100000` to force a particle count.

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

## Data

- Wind: [NOAA GFS](https://registry.opendata.aws/noaa-gfs-bdp-pds/) and [HRRR](https://registry.opendata.aws/noaa-hrrr-pds/).
- Basemap: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data from OpenStreetMap.
- Terrain: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/).

WindDrift shows 10 m model wind for illustration. Don't use it for safety decisions.
