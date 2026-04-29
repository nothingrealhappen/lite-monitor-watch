import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useSearchParams } from "@remix-run/react";

import { getDashboard } from "../services/analytics.server";
import { getDatabasePath } from "../services/db.server";

const allowedWindows = [6, 12, 24, 72] as const;

export const meta: MetaFunction = () => {
  return [
    { title: "Lite Monitor Watch" },
    {
      name: "description",
      content: "A lightweight Remix + SQLite dashboard for time-series hardware monitor snapshots."
    }
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const hours = Number(url.searchParams.get("hours") ?? 72);
  const metric = url.searchParams.get("metric");
  const safeHours = allowedWindows.includes(hours as (typeof allowedWindows)[number]) ? hours : 72;

  return json({
    hours: safeHours,
    metric,
    dashboard: getDashboard(safeHours, metric),
    databasePath: getDatabasePath(),
    sourceConfigured: Boolean(process.env.MONITOR_SOURCE_URL),
    pollIntervalMinutes: Number(process.env.POLL_INTERVAL_MS ?? 60_000) / 60_000
  });
}

function formatNumber(value: number, unit: string | null) {
  const rendered = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rendered}${unit ? ` ${unit}` : ""}`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function Sparkline({ points }: { points: Array<{ recordedAt: string; value: number }> }) {
  if (points.length === 0) {
    return (
      <div className="sparkline" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>
        No samples yet.
      </div>
    );
  }

  const width = 800;
  const height = 240;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);

  const path = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - ((point.value - min) / span) * (height - 30) - 15;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const area = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(17,17,17,0.22)" />
          <stop offset="100%" stopColor="rgba(17,17,17,0.02)" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fill)" />
      <path d={path} fill="none" stroke="#111111" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Index() {
  const { dashboard, hours, databasePath, sourceConfigured, pollIntervalMinutes } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const latest = dashboard.latestSnapshot;
  const selectedMetric = dashboard.selectedMetric;

  return (
    <main className="shell">
      <section className="hero">
        <div className="panel hero-main">
          <div className="eyebrow">Lite Monitor Watch</div>
          <h1>Quiet, local hardware telemetry for the last 72 hours.</h1>
          <p className="hero-copy">
            This dashboard stores snapshots from a configurable sensor source every minute, keeps
            only the rolling last three days in SQLite, and surfaces the signals that matter over
            time: thermal peaks, GPU pressure, load averages, fan behavior, and stability gaps.
          </p>
          <div className="hero-meta">
            <div className="chip">Window: last {hours} hours</div>
            <div className="chip">Polling: every {pollIntervalMinutes} minute(s)</div>
            <div className="chip mono">SQLite: {databasePath}</div>
          </div>
        </div>

        <div className="panel hero-side">
          <div className="status-card">
            <div className="label">Latest capture</div>
            <div className="value">{formatTimestamp(latest?.recordedAt)}</div>
            <div className="subvalue">
              {latest?.sampleCount ?? 0} metrics stored
              {latest?.contentType ? ` • ${latest.contentType}` : ""}
            </div>
          </div>

          <div className="status-card">
            <div className="label">Source status</div>
            <div className="value">{sourceConfigured ? "Configured" : "Missing URL"}</div>
            <div className="subvalue">
              {latest?.note ?? "The collector writes raw payloads and parsed metrics into SQLite."}
            </div>
          </div>

          <div className="status-card">
            <div className="label">Watch health</div>
            <div className="value">
              {dashboard.failures.length === 0 ? "Clean" : `${dashboard.failures.length} recent issues`}
            </div>
            <div className="subvalue">
              Recent collection failures are preserved so the dashboard can explain gaps instead of
              hiding them.
            </div>
          </div>
        </div>
      </section>

      <div className="dashboard-grid">
        <div className="stack">
          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">Window summary</h2>
                <p className="section-subtitle">
                  The dashboard prioritizes metrics that are most actionable over time: thermal
                  peaks, GPU saturation, sustained load, fan response, and power drift.
                </p>
              </div>
              <div className="button-row">
                {allowedWindows.map((windowHours) => {
                  const params = new URLSearchParams(searchParams);
                  params.set("hours", String(windowHours));
                  return (
                    <Link
                      key={windowHours}
                      className={`button-chip${windowHours === hours ? " active" : ""}`}
                      to={`/?${params.toString()}`}
                    >
                      {windowHours}h
                    </Link>
                  );
                })}
              </div>
            </div>

            {dashboard.headlineStats.some((entry) => entry.metric) ? (
              <div className="metric-grid">
                {dashboard.headlineStats.map((entry) => (
                  <article key={entry.label} className="metric-card">
                    <div className="label">{entry.label}</div>
                    <div className="value">
                      {entry.metric ? formatNumber(entry.metric.max, entry.metric.unit) : "n/a"}
                    </div>
                    <div className="details">
                      {entry.metric ? (
                        <>
                          <div>{entry.metric.label}</div>
                          <div>
                            avg {formatNumber(entry.metric.avg, entry.metric.unit)} • last{" "}
                            {formatNumber(entry.metric.latestValue, entry.metric.unit)}
                          </div>
                        </>
                      ) : (
                        <div>No matching samples in this window.</div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                No parsed numeric metrics yet. Once the collector can reach the source URL, this
                panel will start surfacing temperatures, GPU pressure, load, and other meaningful
                time-series signals automatically.
              </div>
            )}
          </section>

          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">
                  {selectedMetric ? selectedMetric.label : "Metric trend"}
                </h2>
                <p className="section-subtitle">
                  Minute-level history for the currently selected signal.
                </p>
              </div>
              {selectedMetric ? (
                <div className={`pill ${dashboard.highlightedMetrics[0]?.status ?? "good"}`}>
                  {selectedMetric.category}
                </div>
              ) : null}
            </div>

            {selectedMetric ? (
              <div className="trend-shell">
                <div className="trend-summary">
                  <div className="mini-stat">
                    <div className="k">Max</div>
                    <div className="v">{formatNumber(selectedMetric.max, selectedMetric.unit)}</div>
                  </div>
                  <div className="mini-stat">
                    <div className="k">Avg</div>
                    <div className="v">{formatNumber(selectedMetric.avg, selectedMetric.unit)}</div>
                  </div>
                  <div className="mini-stat">
                    <div className="k">Min</div>
                    <div className="v">{formatNumber(selectedMetric.min, selectedMetric.unit)}</div>
                  </div>
                  <div className="mini-stat">
                    <div className="k">Latest</div>
                    <div className="v">
                      {formatNumber(selectedMetric.latestValue, selectedMetric.unit)}
                    </div>
                  </div>
                </div>
                <Sparkline points={dashboard.selectedSeries} />
              </div>
            ) : (
              <div className="empty">No metric selected because the database has no usable samples yet.</div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">Priority metrics</h2>
                <p className="section-subtitle">
                  Pick a signal to inspect. Ranking favors CPU/GPU temperatures, hotspot readings,
                  sustained load, fan speeds, and power.
                </p>
              </div>
            </div>

            {dashboard.highlightedMetrics.length > 0 ? (
              <div className="metric-grid">
                {dashboard.highlightedMetrics.map((metric) => (
                  <Link
                    key={metric.key}
                    to={`/?hours=${hours}&metric=${encodeURIComponent(metric.key)}`}
                    className="metric-card"
                  >
                    <div className="label">{metric.label}</div>
                    <div className="value">{formatNumber(metric.max, metric.unit)}</div>
                    <div className="details">
                      <div>{metric.category}</div>
                      <div>
                        avg {formatNumber(metric.avg, metric.unit)} • {metric.sampleCount} samples
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="empty">
                Nothing ranked yet. The collector is ready, but it still needs reachable source
                data to build a meaningful metric shortlist.
              </div>
            )}
          </section>

          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">All metrics</h2>
                <p className="section-subtitle">
                  Everything parsed into time-series rows over the current window.
                </p>
              </div>
            </div>

            {dashboard.metricSummaries.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Category</th>
                      <th>Max</th>
                      <th>Avg</th>
                      <th>Latest</th>
                      <th>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.metricSummaries
                      .slice()
                      .sort((left, right) => right.max - left.max)
                      .map((metric) => (
                        <tr key={`${metric.key}:${metric.label}`}>
                          <td className="metric-name">{metric.label}</td>
                          <td>{metric.category}</td>
                          <td className="mono">{formatNumber(metric.max, metric.unit)}</td>
                          <td className="mono">{formatNumber(metric.avg, metric.unit)}</td>
                          <td className="mono">{formatNumber(metric.latestValue, metric.unit)}</td>
                          <td className="mono">{metric.sampleCount}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">The SQLite store is still empty for this time window.</div>
            )}

            <div className="footnote">
              Raw payloads are kept alongside normalized metrics so the parser can evolve without
              losing historical source material.
            </div>
          </section>

          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">Collector notes</h2>
                <p className="section-subtitle">
                  Collection failures and parser notes are preserved as first-class records.
                </p>
              </div>
            </div>

            {dashboard.failures.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.failures.map((failure) => (
                      <tr key={`${failure.recordedAt}:${failure.note}`}>
                        <td className="mono">{formatTimestamp(failure.recordedAt)}</td>
                        <td>{failure.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">No recent collector issues recorded.</div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
