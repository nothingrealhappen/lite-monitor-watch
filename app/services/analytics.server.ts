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

function metricText(summary: MetricSummary) {
  return `${summary.key} ${summary.label}`.toLowerCase();
}

function isDerivedMetric(summary: MetricSummary) {
  return summary.category === "derived" || summary.key.endsWith(".pct") || summary.key.endsWith(".status");
}

function isVisibleMetric(summary: MetricSummary) {
  if (isDerivedMetric(summary)) return false;
  if (summary.key.startsWith("DASH.")) return false;
  return true;
}

function metricPriority(summary: MetricSummary) {
  const text = metricText(summary);
  let priority = 0;
  if (text.includes("cpu.temp")) priority += 96;
  if (text.includes("gpu.temp")) priority += 94;
  if (text.includes("mem.load")) priority += 90;
  if (text.includes("disk.temp")) priority += 82;
  if (text.includes("mobo.temp")) priority += 80;
  if (text.includes("gpu.vram")) priority += 76;
  if (text.includes("cpu.load")) priority += 74;
  if (text.includes("gpu.load")) priority += 72;
  if (text.includes("net.down")) priority += 66;
  if (text.includes("net.up")) priority += 64;
  if (text.includes("data.daydown")) priority += 58;
  if (text.includes("data.dayup")) priority += 56;
  if (text.includes("cpu package")) priority += 54;
  if (text.includes("gpu core") || text.includes("gpu temp")) priority += 52;
  if (text.includes("hotspot")) priority += 50;
  if (summary.category === "temperature") priority += 42;
  if (summary.category === "gpu") priority += 36;
  if (summary.category === "cpu") priority += 32;
  if (summary.category === "memory") priority += 30;
  if (summary.category === "disk") priority += 22;
  if (summary.category === "network") priority += 20;
  if (summary.category === "traffic") priority += 18;
  if (summary.category === "fan") priority += 16;
  if (summary.category === "power") priority += 14;
  if (summary.category === "load") priority += 12;
  if (summary.unit === "°C") priority += 20;
  if (summary.unit === "%") priority += 10;
  if (summary.unit === "KB/s" || summary.unit === "MB/s") priority += 8;
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
  const visibleMetrics = metricSummaries.filter(isVisibleMetric);
  const highlightedMetrics = [...visibleMetrics]
    .sort((left, right) => metricPriority(right) - metricPriority(left))
    .slice(0, 8)
    .map((summary) => ({
      ...summary,
      status: categoryStatus(summary)
    }));

  const selectedMetric =
    visibleMetrics.find((item) => item.key === preferredMetricKey) ??
    highlightedMetrics[0] ??
    null;

  const selectedSeries = selectedMetric ? getMetricSeries(selectedMetric.key, hours) : [];
  const failures = getRecentFailures(hours);

  const pickMetric = (matcher: (metric: MetricSummary) => boolean) =>
    [...visibleMetrics].filter(matcher).sort((left, right) => metricPriority(right) - metricPriority(left))[0] ??
    null;

  return {
    latestSnapshot,
    metricSummaries: visibleMetrics,
    highlightedMetrics,
    selectedMetric,
    selectedSeries,
    failures,
    headlineStats: [
      {
        label: "CPU peak temp",
        metric: pickMetric((metric) => metricText(metric).includes("cpu.temp"))
      },
      {
        label: "GPU peak temp",
        metric: pickMetric((metric) => metricText(metric).includes("gpu.temp"))
      },
      {
        label: "Memory peak load",
        metric: pickMetric((metric) => metricText(metric).includes("mem.load"))
      },
      {
        label: "Disk peak temp",
        metric: pickMetric((metric) => metricText(metric).includes("disk.temp"))
      },
      {
        label: "Download burst",
        metric: pickMetric((metric) => metricText(metric).includes("net.down"))
      },
      {
        label: "Today's total download",
        metric: pickMetric((metric) => metricText(metric).includes("data.daydown"))
      }
    ]
  };
}
