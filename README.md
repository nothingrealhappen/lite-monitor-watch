# lite-monitor-watch

A lightweight `Remix + SQLite` hardware telemetry watcher.

It polls a configurable sensor source every minute, stores both the raw payload and
flattened numeric metrics, keeps only the last 72 hours by default, and serves a
small dashboard on port `35001`.

## Why this shape

- `Remix` keeps the web app simple and server-first.
- `SQLite` keeps the state local and cheap.
- Node's built-in `node:sqlite` avoids an extra ORM or external database.
- The collector stores raw payloads and normalized metrics together, so the parser can
  evolve later without losing historical source material.

## What gets stored

Two tables back the app:

- `snapshots`
  - one row per poll
  - raw payload, content type, parser note, sample count
- `metric_samples`
  - one row per numeric metric found in the payload
  - metric key, label, category, unit, numeric value, timestamp

## Environment variables

Create a `.env` file from `.env.example`.

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---:|---|
| `MONITOR_SOURCE_URL` | none | Sensor source URL, for example `http://win:35000/` |
| `PORT` | `35001` | Dashboard port |
| `DATABASE_PATH` | `./data/monitor.sqlite` | SQLite database location |
| `POLL_INTERVAL_MS` | `60000` | Poll every minute by default |
| `RETENTION_HOURS` | `72` | Keep only the latest 3 days |

`MONITOR_SOURCE_URL` is intentionally environment-only and never hard-coded into the repo.

## Local development

```bash
npm install
npm run dev
```

This runs:

- the Remix dev server on `http://localhost:35001`
- the poller in a parallel process

For a one-off collection attempt:

```bash
npm run db:poll
```

## Docker

Build:

```bash
docker build -t lite-monitor-watch .
```

Run:

```bash
docker run --rm \
  -p 35001:35001 \
  -e MONITOR_SOURCE_URL=http://win:35000/ \
  -e PORT=35001 \
  -e DATABASE_PATH=/app/data/monitor.sqlite \
  -v "$(pwd)/data:/app/data" \
  lite-monitor-watch
```

## Current parser behavior

The collector supports:

- direct JSON payloads
- JSON embedded in `<script type="application/json">`
- table-based HTML dashboards where rows contain sensor names and value columns
- numeric strings like `47 °C`, `68 %`, `1750 RPM`, `224 W`

The parser ranks dashboard metrics by usefulness over time:

1. CPU and GPU temperatures
2. hotspot / peak thermal readings
3. sustained load percentages
4. fan RPM behavior
5. power draw
6. clocks and memory signals

## Notes

- If the source host is unreachable, the app still records the failure in `snapshots.note`.
- The dashboard defaults to the last `72` hours and supports shorter windows.
- The current environment where this repo was bootstrapped could not reach `http://win:35000/`,
  so the parser was designed defensively to handle multiple source shapes once the source becomes reachable.
