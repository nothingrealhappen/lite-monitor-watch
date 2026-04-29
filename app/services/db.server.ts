import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/monitor.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

declare global {
  // eslint-disable-next-line no-var
  var __liteMonitorDb__: DatabaseSync | undefined;
}

export const db =
  global.__liteMonitorDb__ ??
  new DatabaseSync(databasePath, {
    open: true
  });

if (!global.__liteMonitorDb__) {
  global.__liteMonitorDb__ = db;
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    source_url TEXT,
    content_type TEXT,
    raw_payload TEXT,
    sample_count INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS metric_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_label TEXT NOT NULL,
    category TEXT NOT NULL,
    unit TEXT,
    numeric_value REAL NOT NULL,
    raw_value TEXT,
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_metric_samples_recorded_at ON metric_samples(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_metric_samples_metric_key ON metric_samples(metric_key);
  CREATE INDEX IF NOT EXISTS idx_metric_samples_category ON metric_samples(category);
  CREATE INDEX IF NOT EXISTS idx_snapshots_recorded_at ON snapshots(recorded_at);
`);

export type MetricSampleInput = {
  key: string;
  label: string;
  category: string;
  unit: string | null;
  value: number;
  rawValue: string | null;
};

export function insertSnapshot(input: {
  recordedAt: string;
  sourceUrl: string | null;
  contentType: string | null;
  rawPayload: string | null;
  note: string | null;
  samples: MetricSampleInput[];
}) {
  const snapshotStatement = db.prepare(`
    INSERT INTO snapshots (
      recorded_at,
      source_url,
      content_type,
      raw_payload,
      sample_count,
      note
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const sampleStatement = db.prepare(`
    INSERT INTO metric_samples (
      snapshot_id,
      recorded_at,
      metric_key,
      metric_label,
      category,
      unit,
      numeric_value,
      raw_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");

  try {
    const result = snapshotStatement.run(
      input.recordedAt,
      input.sourceUrl,
      input.contentType,
      input.rawPayload,
      input.samples.length,
      input.note
    );
    const snapshotId = Number(result.lastInsertRowid);

    for (const sample of input.samples) {
      sampleStatement.run(
        snapshotId,
        input.recordedAt,
        sample.key,
        sample.label,
        sample.category,
        sample.unit,
        sample.value,
        sample.rawValue
      );
    }

    db.exec("COMMIT");
    return snapshotId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function purgeOldData(retentionHours: number) {
  db.prepare(
    `DELETE FROM snapshots WHERE recorded_at < datetime('now', '-' || ? || ' hours')`
  ).run(retentionHours);
}

export function getDatabasePath() {
  return databasePath;
}
