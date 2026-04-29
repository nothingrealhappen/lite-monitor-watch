import * as cheerio from "cheerio";

import { insertSnapshot, purgeOldData, type MetricSampleInput } from "./db.server";

const numberWithOptionalUnit =
  /(-?\d+(?:\.\d+)?)\s*(°C|℃|C|%|RPM|MHz|GHz|W|kW|V|A|GB|GiB|MB|MiB|KB\/s|MB\/s|W\/h|Wh)?/i;

type CollectResult = {
  status: "stored" | "skipped" | "unreachable";
  sampleCount: number;
  note?: string;
};

type SnapshotApiResponse = {
  sys?: {
    ip?: string;
    port?: number;
    uptime?: string;
  };
  items?: Array<{
    k?: string;
    n?: string;
    gid?: string;
    gn?: string;
    v?: string | number;
    u?: string;
    pct?: number;
    sts?: number;
    primary?: boolean;
  }>;
};

function normalizeMetricKey(parts: string[]) {
  return parts
    .join(".")
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
}

function toCategory(key: string, label: string) {
  const text = `${key} ${label}`.toLowerCase();
  if (text.includes("net.") || text.includes("upload") || text.includes("download")) return "network";
  if (text.includes("data.") || text.includes("流量")) return "traffic";
  if (text.includes("disk.") || text.includes("磁盘")) return "disk";
  if (text.includes("mobo.") || text.includes("主板")) return "motherboard";
  if (text.includes("mem.") || text.includes("内存") || text.includes("vram")) return "memory";
  if (text.includes("gpu")) return "gpu";
  if (text.includes("cpu")) return "cpu";
  if (text.includes("temp") || text.includes("temperature") || text.includes("℃") || text.includes("°c")) {
    return "temperature";
  }
  if (text.includes("fan") || text.includes("rpm")) return "fan";
  if (text.includes("power") || text.includes("watt") || /(^|[^a-z])w([^a-z]|$)/.test(text)) return "power";
  if (text.includes("load") || text.includes("usage") || text.includes("%")) return "load";
  if (text.includes("clock") || text.includes("mhz") || text.includes("ghz")) return "clock";
  if (text.includes("memory") || text.includes("ram")) return "memory";
  if (text.includes("voltage") || /(^|[^a-z])v([^a-z]|$)/.test(text)) return "voltage";
  return "other";
}

function parseMetricValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { numericValue: value, rawValue: String(value), unit: null as string | null };
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(numberWithOptionalUnit);
  if (!match) {
    return null;
  }

  return {
    numericValue: Number(match[1]),
    rawValue: trimmed,
    unit: match[2] ? match[2].replace("℃", "°C") : null
  };
}

function extractFromSnapshotApi(payload: SnapshotApiResponse) {
  const samples: MetricSampleInput[] = [];

  for (const item of payload.items ?? []) {
    if (!item.k || !item.n) continue;
    const parsed = parseMetricValue(item.v);
    if (!parsed) continue;

    const labelParts = [item.gn, item.n].filter(Boolean);
    const label = labelParts.join(" / ");
    samples.push({
      key: item.k,
      label,
      category: toCategory(item.k, `${item.gid ?? ""} ${item.gn ?? ""} ${item.n}`),
      unit: item.u?.trim() || parsed.unit,
      value: parsed.numericValue,
      rawValue: parsed.rawValue
    });

    if (typeof item.pct === "number" && Number.isFinite(item.pct)) {
      samples.push({
        key: `${item.k}.pct`,
        label: `${label} / Percent`,
        category: "derived",
        unit: "%",
        value: item.pct,
        rawValue: String(item.pct)
      });
    }

    if (typeof item.sts === "number" && Number.isFinite(item.sts)) {
      samples.push({
        key: `${item.k}.status`,
        label: `${label} / Status`,
        category: "derived",
        unit: null,
        value: item.sts,
        rawValue: String(item.sts)
      });
    }
  }

  return samples;
}

function extractFromJson(input: unknown, path: string[] = [], samples: MetricSampleInput[] = []): MetricSampleInput[] {
  if (Array.isArray(input)) {
    input.forEach((entry, index) => extractFromJson(entry, [...path, String(index)], samples));
    return samples;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;

    if (
      typeof record.name === "string" &&
      (typeof record.value === "number" || typeof record.value === "string")
    ) {
      const parsed = parseMetricValue(record.value);
      if (parsed) {
        const key = normalizeMetricKey([...path, record.name]);
        samples.push({
          key,
          label: record.name,
          category: toCategory(key, record.name),
          unit: typeof record.unit === "string" ? record.unit : parsed.unit,
          value: parsed.numericValue,
          rawValue: parsed.rawValue
        });
      }
    }

    for (const [key, value] of Object.entries(record)) {
      extractFromJson(value, [...path, key], samples);
    }
    return samples;
  }

  const parsed = parseMetricValue(input);
  if (parsed && path.length > 0) {
    const key = normalizeMetricKey(path);
    samples.push({
      key,
      label: path[path.length - 1] ?? key,
      category: toCategory(key, path.join(" ")),
      unit: parsed.unit,
      value: parsed.numericValue,
      rawValue: parsed.rawValue
    });
  }

  return samples;
}

function extractFromHtml(html: string) {
  const $ = cheerio.load(html);
  const samples: MetricSampleInput[] = [];

  $("script[type='application/json'], script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      extractFromJson(parsed, ["script"], samples);
    } catch {
      // ignore malformed inline json
    }
  });

  $("table").each((_, table) => {
    const headings = $(table)
      .find("thead th")
      .map((__, th) => $(th).text().trim())
      .get();

    $(table)
      .find("tbody tr")
      .each((__, row) => {
        const cells = $(row)
          .find("td")
          .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();

        if (cells.length < 2) return;
        const rowLabel = cells[0];

        cells.slice(1).forEach((cell, index) => {
          const parsed = parseMetricValue(cell);
          if (!parsed) return;
          const columnLabel = headings[index + 1] || `value_${index + 1}`;
          const key = normalizeMetricKey(["table", rowLabel, columnLabel]);
          samples.push({
            key,
            label: `${rowLabel} / ${columnLabel}`,
            category: toCategory(key, `${rowLabel} ${columnLabel}`),
            unit: parsed.unit,
            value: parsed.numericValue,
            rawValue: parsed.rawValue
          });
        });
      });
  });

  $("[data-value], [data-temp], [data-temperature], [data-load]").each((_, node) => {
    const attrs = node.attribs ?? {};
    for (const [keyName, rawValue] of Object.entries(attrs)) {
      if (!keyName.startsWith("data-")) continue;
      const parsed = parseMetricValue(rawValue);
      if (!parsed) continue;
      const label = `${node.tagName} ${keyName}`;
      const key = normalizeMetricKey(["data", node.tagName, keyName]);
      samples.push({
        key,
        label,
        category: toCategory(key, label),
        unit: parsed.unit,
        value: parsed.numericValue,
        rawValue: parsed.rawValue
      });
    }
  });

  return samples;
}

function dedupeMetrics(samples: MetricSampleInput[]) {
  const map = new Map<string, MetricSampleInput>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const stableKey = `${sample.key}::${sample.label}::${sample.unit ?? ""}`;
    const existing = map.get(stableKey);
    if (!existing) {
      map.set(stableKey, sample);
    } else if (Math.abs(sample.value) > Math.abs(existing.value)) {
      map.set(stableKey, sample);
    }
  }

  return [...map.values()];
}

export async function collectAndStoreSnapshot(): Promise<CollectResult> {
  const sourceUrl = process.env.MONITOR_SOURCE_URL;
  const retentionHours = Number(process.env.RETENTION_HOURS ?? 72);

  purgeOldData(retentionHours);

  if (!sourceUrl) {
    insertSnapshot({
      recordedAt: new Date().toISOString(),
      sourceUrl: null,
      contentType: null,
      rawPayload: null,
      note: "MONITOR_SOURCE_URL is not configured",
      samples: []
    });

    return {
      status: "skipped",
      sampleCount: 0,
      note: "MONITOR_SOURCE_URL is not configured"
    };
  }

  try {
    const apiUrl = new URL(sourceUrl);
    apiUrl.pathname = apiUrl.pathname.replace(/\/$/, "") + "/api/snapshot";

    let response = await fetch(apiUrl, {
      headers: {
        "user-agent": "lite-monitor-watch/0.1"
      }
    });

    if (!response.ok) {
      response = await fetch(sourceUrl, {
        headers: {
          "user-agent": "lite-monitor-watch/0.1"
        }
      });
    }

    const contentType = response.headers.get("content-type");
    const body = await response.text();
    const recordedAt = new Date().toISOString();
    let samples: MetricSampleInput[] = [];
    let note: string | null = null;

    if (!response.ok) {
      note = `Source responded with ${response.status}`;
    } else if (contentType?.includes("json")) {
      try {
        const parsedPayload = JSON.parse(body) as SnapshotApiResponse;
        if (Array.isArray(parsedPayload.items)) {
          samples = dedupeMetrics(extractFromSnapshotApi(parsedPayload));
        } else {
          samples = dedupeMetrics(extractFromJson(parsedPayload, ["root"]));
        }
      } catch (error) {
        note = `Failed to parse JSON: ${String(error)}`;
      }
    } else {
      try {
        const parsedJson = JSON.parse(body);
        samples = dedupeMetrics(extractFromJson(parsedJson, ["root"]));
      } catch {
        samples = dedupeMetrics(extractFromHtml(body));
      }
    }

    insertSnapshot({
      recordedAt,
      sourceUrl: response.url,
      contentType,
      rawPayload: body,
      note,
      samples
    });

    return {
      status: "stored",
      sampleCount: samples.length,
      note: note ?? undefined
    };
  } catch (error) {
    insertSnapshot({
      recordedAt: new Date().toISOString(),
      sourceUrl,
      contentType: null,
      rawPayload: null,
      note: `Request failed: ${String(error)}`,
      samples: []
    });

    return {
      status: "unreachable",
      sampleCount: 0,
      note: `Request failed: ${String(error)}`
    };
  }
}
