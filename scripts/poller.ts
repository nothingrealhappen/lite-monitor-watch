import { collectAndStoreSnapshot } from "../app/services/collector.server";

const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const once = process.argv.includes("--once");

async function run(): Promise<void> {
  try {
    const result = await collectAndStoreSnapshot();
    console.log(
      `[poller] ${new Date().toISOString()} status=${result.status} samples=${result.sampleCount} note=${result.note ?? "-"}`
    );
  } catch (error) {
    console.error("[poller] unexpected failure", error);
  }
}

async function main(): Promise<void> {
  await run();
  if (once) {
    return;
  }

  setInterval(() => {
    void run();
  }, intervalMs);
}

void main();
