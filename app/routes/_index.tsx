import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";

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

type DashboardMetric = {
  key: string;
  label: string;
  category: string;
  unit: string | null;
  sampleCount: number;
  min: number;
  max: number;
  avg: number;
  latestValue: number;
  latestAt: string;
};

function metricTone(metric: Pick<DashboardMetric, "key" | "category" | "label">) {
  const text = `${metric.key} ${metric.category} ${metric.label}`.toLowerCase();
  if (text.includes("gpu")) return "gpu";
  if (text.includes("cpu")) return "cpu";
  if (text.includes("memory") || text.includes("mem.") || text.includes("vram")) return "memory";
  if (text.includes("disk")) return "disk";
  if (text.includes("network") || text.includes("net.")) return "network";
  if (text.includes("traffic") || text.includes("data.")) return "traffic";
  if (text.includes("motherboard") || text.includes("mobo")) return "motherboard";
  return "other";
}

function metricStatus(metric: Pick<DashboardMetric, "avg" | "max" | "unit">) {
  if (metric.unit === "°C") {
    if (metric.max >= 90) return "bad";
    if (metric.max >= 75) return "warn";
    return "good";
  }
  if (metric.unit === "%") {
    if (metric.avg >= 92) return "bad";
    if (metric.avg >= 75) return "warn";
    return "good";
  }
  return "good";
}

function toneColor(tone: string) {
  switch (tone) {
    case "cpu":
      return "#a6e22e";
    case "gpu":
      return "#66d9ef";
    case "memory":
      return "#ae81ff";
    case "disk":
      return "#e6db74";
    case "network":
      return "#fd971f";
    case "traffic":
      return "#f92672";
    case "motherboard":
      return "#78dce8";
    default:
      return "#f8f8f2";
  }
}

function Sparkline({
  points,
  tone = "other"
}: {
  points: Array<{ recordedAt: string; value: number }>;
  tone?: string;
}) {
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
  const stroke = toneColor(tone);
  const gradientId = `spark-fill-${tone}-${points.length}`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.32" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Index() {
  const { dashboard, hours, databasePath, sourceConfigured, pollIntervalMinutes } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const latest = dashboard.latestSnapshot;
  const selectedMetric = dashboard.selectedMetric;
  const selectedTone = selectedMetric ? metricTone(selectedMetric) : "other";
  const selectedStatus = selectedMetric ? metricStatus(selectedMetric) : "good";
  const metricQueryHref = (metricKey: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (metricKey) {
      params.set("metric", metricKey);
    } else {
      params.delete("metric");
    }
    return `/?${params.toString()}`;
  };

  return (
    <main className="shell">
      <section className="hero">
        <div className="panel hero-main">
          <div className="eyebrow">Lite Monitor Watch</div>
          <h1>Quiet, local hardware telemetry for the last 72 hours.</h1>
          <p className="hero-copy">
            This dashboard stores snapshots from a configurable sensor source every minute, keeps
            only the rolling last three days in SQLite, and surfaces the signals that matter over
            time: CPU and GPU temperatures, memory pressure, disk heat, burst bandwidth, and daily
            transfer totals.
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
              {latest?.note ??
                "The collector prefers /api/snapshot and stores both raw payloads and normalized metrics."}
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
                  Summary cards are tuned for the real hardware feed: CPU and GPU thermals, memory
                  load, disk temperature, live download rate, and today&apos;s transfer total.
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
                  <button
                    key={entry.label}
                    type="button"
                    className={`metric-card interactive tone-${entry.metric ? metricTone(entry.metric) : "other"}`}
                    onClick={() => entry.metric && navigate(metricQueryHref(entry.metric.key))}
                  >
                    <div className="metric-card-top">
                      <div className="label">{entry.label}</div>
                      {entry.metric ? (
                        <div className={`metric-badge ${metricStatus(entry.metric)}`}>
                          {entry.metric.category}
                        </div>
                      ) : null}
                    </div>
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
                  </button>
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
                <div className={`pill ${selectedStatus} tone-${selectedTone}`}>
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
                <Sparkline points={dashboard.selectedSeries} tone={selectedTone} />
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
                  Pick a signal to inspect. Ranking favors CPU/GPU temperatures, memory pressure,
                  disk temperature, network throughput, and daily traffic counters.
                </p>
              </div>
            </div>

            {dashboard.highlightedMetrics.length > 0 ? (
              <div className="metric-grid">
                {dashboard.highlightedMetrics.map((metric) => (
                  <button
                    key={metric.key}
                    type="button"
                    className={`metric-card interactive tone-${metricTone(metric)}`}
                    onClick={() => navigate(metricQueryHref(metric.key))}
                  >
                    <div className="metric-card-top">
                      <div className="label">{metric.label}</div>
                      <div className={`metric-badge ${metric.status}`}>{metric.category}</div>
                    </div>
                    <div className="value">{formatNumber(metric.max, metric.unit)}</div>
                    <div className="details">
                      <div>{formatTimestamp(metric.latestAt)}</div>
                      <div>
                        avg {formatNumber(metric.avg, metric.unit)} • {metric.sampleCount} samples
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                Nothing ranked yet. The collector is ready, but it still needs reachable snapshot
                data to build a meaningful shortlist.
              </div>
            )}
          </section>

          <section className="panel section">
            <div className="section-header">
              <div>
                <h2 className="section-title">All metrics</h2>
                <p className="section-subtitle">
                  All normalized sensor values over the current window, with derived status fields
                  intentionally hidden from the main view.
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
                          <td className="metric-name">
                            <button
                              type="button"
                              className={`table-metric-link tone-${metricTone(metric)}`}
                              onClick={() => navigate(metricQueryHref(metric.key))}
                            >
                              {metric.label}
                            </button>
                          </td>
                          <td>
                            <span className={`metric-badge ${metricStatus(metric)}`}>{metric.category}</span>
                          </td>
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

      {selectedMetric ? (
        <div className="modal-backdrop" onClick={() => navigate(metricQueryHref(null))} role="presentation">
          <section
            className={`modal-shell tone-${selectedTone}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="metric-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">Metric Detail</div>
                <h2 id="metric-modal-title" className="modal-title">
                  {selectedMetric.label}
                </h2>
                <p className="section-subtitle">
                  Expanded view for the selected metric across the last {hours} hours.
                </p>
              </div>
              <div className="modal-actions">
                <div className={`pill ${selectedStatus} tone-${selectedTone}`}>{selectedMetric.category}</div>
                <button type="button" className="modal-close" onClick={() => navigate(metricQueryHref(null))}>
                  Close
                </button>
              </div>
            </div>

            <div className="modal-grid">
              <div className="trend-shell">
                <Sparkline points={dashboard.selectedSeries} tone={selectedTone} />
                <div className="metric-grid compact">
                  <article className={`metric-card tone-${selectedTone}`}>
                    <div className="label">Latest</div>
                    <div className="value">{formatNumber(selectedMetric.latestValue, selectedMetric.unit)}</div>
                    <div className="details">
                      <div>{formatTimestamp(selectedMetric.latestAt)}</div>
                    </div>
                  </article>
                  <article className={`metric-card tone-${selectedTone}`}>
                    <div className="label">Window max</div>
                    <div className="value">{formatNumber(selectedMetric.max, selectedMetric.unit)}</div>
                    <div className="details">
                      <div>min {formatNumber(selectedMetric.min, selectedMetric.unit)}</div>
                    </div>
                  </article>
                </div>
              </div>

              <div className="stack modal-side">
                <article className={`metric-card tone-${selectedTone}`}>
                  <div className="label">Profile</div>
                  <div className="details">
                    <div>Average {formatNumber(selectedMetric.avg, selectedMetric.unit)}</div>
                    <div>{selectedMetric.sampleCount} samples in window</div>
                    <div>Key: {selectedMetric.key}</div>
                  </div>
                </article>

                <article className={`metric-card tone-${selectedTone}`}>
                  <div className="label">Read</div>
                  <div className="details">
                    <div>
                      This metric is highlighted because it is one of the more decision-useful
                      signals in the current hardware feed.
                    </div>
                    <div>
                      Opened from the dashboard so you can inspect thermal, load, network, or
                      traffic behavior without leaving the page.
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
