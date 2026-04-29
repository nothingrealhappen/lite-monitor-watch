# lite-monitor-watch

A lightweight `Remix + SQLite` hardware telemetry watcher.

It polls a configurable sensor source every minute, stores both the raw payload and
flattened numeric metrics, keeps only the last 72 hours by default, and serves a
small dashboard on port `35001`.

## Prerequisite

Before using this dashboard, install LiteMonitor first:

- LiteMonitor: <https://github.com/Diorser/LiteMonitor>

After installing it, enable:

- startup on boot
- the web dashboard / web display

This project depends on LiteMonitor exposing its local web telemetry feed.

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
| `MONITOR_SOURCE_URL` | none | Sensor source URL, for example `http://100.88.178.2:35000/` |
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
  -e MONITOR_SOURCE_URL=http://100.88.178.2:35000/ \
  -e PORT=35001 \
  -e DATABASE_PATH=/app/data/monitor.sqlite \
  -v "$(pwd)/data:/app/data" \
  lite-monitor-watch
```

For a long-running local deployment with auto-restart:

```bash
docker compose up -d --build
```

The compose file defaults `MONITOR_SOURCE_URL` to `http://100.88.178.2:35000/`
but still allows overriding it through the shell environment.

## Current parser behavior

The collector prefers the source's `/api/snapshot` JSON endpoint and falls back to HTML parsing if
that API is unavailable.

It currently recognizes the real feed's main metric families:

- CPU: load, temp, clock, power, voltage, fan, pump
- GPU: load, temp, clock, power, fan, VRAM
- Host: memory load, FPS, disk temp, motherboard temp, case fan
- Disk: read/write throughput
- Network: up/down throughput
- Daily totals: today's upload/download

The fallback parser still supports:

- direct JSON payloads
- JSON embedded in `<script type="application/json">`
- table-based HTML dashboards where rows contain sensor names and value columns
- numeric strings like `47 °C`, `68 %`, `1750 RPM`, `224 W`

The dashboard prioritizes the most decision-useful metrics over time:

1. CPU and GPU temperatures
2. memory pressure and VRAM usage
3. disk / motherboard thermal readings
4. network bursts and daily transfer totals
5. sustained load and power behavior

## Notes

- If the source host is unreachable, the app still records the failure in `snapshots.note`.
- The dashboard defaults to the last `72` hours and supports shorter windows.
- In the current environment, the host shell could not reach the monitor URL directly, but the
  Docker container could, so `docker compose up -d --build` is the recommended local deployment path.
