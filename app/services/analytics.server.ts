import { db } from "./db.server";

export type MetricSummary = {
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

export type MetricPoint = {
  recordedAt: string;
  value: number;
};

function metricPriority(summary: MetricSummary) {
  const text = `${summary.key} ${summary.label}`.toLowerCase();
  let priority = 0;
  if (text.includes("cpu package")) priority += 90;
  if (text.includes("gpu core") || text.includes("gpu temp")) priority += 88;
  if (text.includes("hotspot")) priority += 86;
  if (summary.category === "temperature") priority += 70;
  if (summary.category === "gpu") priority += 65;
  if (summary.category === "cpu") priority += 60;
  if (summary.category === "fan") priority += 45;
  if (summary.category === "power") priority += 42;
  if (summary.category === "load") priority += 38;
  if (summary.unit === "°C") priority += 20;
  if (summary.unit === "%") priority += 6;
  return priority + summary.sampleCount / 100;
}

function categoryStatus(summary: MetricSummary) {
  if (summary.unit === "°C") {
    if (summary.max >= 90) return "bad";
    if (summary.max >= 75) return "warn";
    return "good";
  }
  if (summary.unit === "%") {
    if (summary.avg >= 92) return "bad";
    if (summary.avg >= 75) return "warn";
    return "good";
  }
  return "good";
}

export function getLatestSnapshot() {
  return db
    .prepare(
      `SELECT id, recorded_at as recordedAt, source_url as sourceUrl, content_type as contentType,
              sample_count as sampleCount, note
       FROM snapshots
       ORDER BY recorded_at DESC
       LIMIT 1`
    )
    .get() as
    | {
        id: number;
        recordedAt: string;
        sourceUrl: string | null;
        contentType: string | null;
        sampleCount: number;
        note: string | null;
      }
    | undefined;
}

export function getMetricSummaries(hours: number) {
  return db
    .prepare(
      `SELECT
         metric_key as key,
         metric_label as label,
         category,
         unit,
         COUNT(*) as sampleCount,
         MIN(numeric_value) as min,
         MAX(numeric_value) as max,
         AVG(numeric_value) as avg,
         (
           SELECT numeric_value
           FROM metric_samples ms2
           WHERE ms2.metric_key = ms.metric_key
             AND ms2.recorded_at >= datetime('now', '-' || ? || ' hours')
           ORDER BY ms2.recorded_at DESC
           LIMIT 1
         ) as latestValue,
         (
           SELECT recorded_at
           FROM metric_samples ms2
           WHERE ms2.metric_key = ms.metric_key
             AND ms2.recorded_at >= datetime('now', '-' || ? || ' hours')
           ORDER BY ms2.recorded_at DESC
           LIMIT 1
         ) as latestAt
       FROM metric_samples ms
       WHERE recorded_at >= datetime('now', '-' || ? || ' hours')
       GROUP BY metric_key, metric_label, category, unit`
    )
    .all(hours, hours, hours) as MetricSummary[];
}

export function getMetricSeries(metricKey: string, hours: number) {
  return db
    .prepare(
      `SELECT recorded_at as recordedAt, numeric_value as value
       FROM metric_samples
       WHERE metric_key = ?
         AND recorded_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY recorded_at ASC`
    )
    .all(metricKey, hours) as MetricPoint[];
}

export function getRecentFailures(hours: number) {
  return db
    .prepare(
      `SELECT recorded_at as recordedAt, note
       FROM snapshots
       WHERE recorded_at >= datetime('now', '-' || ? || ' hours')
         AND note IS NOT NULL
       ORDER BY recorded_at DESC
       LIMIT 10`
    )
    .all(hours) as Array<{ recordedAt: string; note: string }>;
}

export function getDashboard(hours: number, preferredMetricKey?: string | null) {
  const latestSnapshot = getLatestSnapshot();
  const metricSummaries = getMetricSummaries(hours);
  const highlightedMetrics = [...metricSummaries]
    .sort((left, right) => metricPriority(right) - metricPriority(left))
    .slice(0, 8)
    .map((summary) => ({
      ...summary,
      status: categoryStatus(summary)
    }));

  const selectedMetric =
    metricSummaries.find((item) => item.key === preferredMetricKey) ??
    highlightedMetrics[0] ??
    null;

  const selectedSeries = selectedMetric ? getMetricSeries(selectedMetric.key, hours) : [];
  const failures = getRecentFailures(hours);

  const hottestToday = [...metricSummaries]
    .filter((metric) => metric.unit === "°C")
    .sort((left, right) => right.max - left.max)[0];

  const gpuPeak = [...metricSummaries]
    .filter((metric) => metric.category === "gpu" || metric.label.toLowerCase().includes("gpu"))
    .sort((left, right) => right.max - left.max)[0];

  const loadAverage =
    [...metricSummaries]
      .filter((metric) => metric.unit === "%" || metric.category === "load")
      .sort((left, right) => metricPriority(right) - metricPriority(left))[0] ?? null;

  return {
    latestSnapshot,
    metricSummaries,
    highlightedMetrics,
    selectedMetric,
    selectedSeries,
    failures,
    headlineStats: [
      {
        label: "Today's hottest metric",
        metric: hottestToday
      },
      {
        label: "GPU peak",
        metric: gpuPeak
      },
      {
        label: "Average active load",
        metric: loadAverage
      }
    ]
  };
}
