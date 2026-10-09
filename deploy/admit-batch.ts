// A separate Actions step: a denied run never starts handlers or changes worker heartbeats.
import { appendFile } from "node:fs/promises";
import { admitBatch } from "@aihot/backend/operations/batch-admission";
import { closeDb, sql } from "@aihot/backend/db";

try {
  const trigger = process.env.BATCH_TRIGGER_SOURCE ?? "manual";
  if (!["manual", "schedule", "cloudflare"].includes(trigger)) throw new Error("Invalid batch trigger");
  const result = await admitBatch({
    intervalMinutes: Number(process.env.BATCH_MIN_INTERVAL_MINUTES ?? "55"),
    source: trigger === "cloudflare" ? "cloudflare-cron" : process.env.GITHUB_RUN_ID ? "github-actions" : "local",
    ownerRunId: process.env.GITHUB_RUN_ID,
  });
  const detail = {
    admitted: result.admitted,
    admittedAt: result.admittedAt.toISOString(),
    nextEligibleAt: result.nextEligibleAt.toISOString(),
  };
  await sql`INSERT INTO job_runs (job, status, finished_at, detail)
    VALUES ('batch.admission', ${result.admitted ? "ok" : "skipped"}, now(), ${sql.json(detail)})`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `admitted=${result.admitted}\n`);
  }
  console.log(JSON.stringify({ stage: "batch.admission", ...detail }));
} catch {
  // Do not print database errors: they can include authenticated connection strings.
  console.error(JSON.stringify({ stage: "batch.admission.failed" }));
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {
    console.error(JSON.stringify({ stage: "batch.admission.close_failed" }));
    process.exitCode = 1;
  });
}
