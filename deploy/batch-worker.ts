// An hourly, finite processing run. Durable jobs remain in PostgreSQL between runs.
import { setTimeout as delay } from "node:timers/promises";
import { assertProductionSecrets } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, recordRun, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { scheduleDueSources } from "@aihot/backend/sources/collect";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { refreshStoryStatuses } from "@aihot/backend/events/digest";
import { linkRelatedStories } from "@aihot/backend/events/group";
import { catchUpReports } from "@aihot/backend/reports/compose";
import { beat, startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);
const maximumMinutes = Number(process.env.BATCH_MAX_MINUTES || 20);
if (!Number.isFinite(maximumMinutes) || maximumMinutes < 0.2 || maximumMinutes > 40) throw new Error("Invalid BATCH_MAX_MINUTES");
const deadline = Date.now() + maximumMinutes * 60_000;
let heartbeat: NodeJS.Timeout | undefined;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  await stopBoss();
  await beat("worker", {mode:"batch",status:code ? "failed" : "finished"}).catch(()=>{});
  await closeDb();
  process.exit(code);
}
process.on("SIGTERM",()=>void shutdown());process.on("SIGINT",()=>void shutdown());
// Leave time for the existing 195 s graceful shutdown before Actions' job timeout.
const hardStop = setTimeout(()=>void shutdown(), maximumMinutes * 60_000);
hardStop.unref();
try {
  const boss = await getBoss();
  // Disable legacy continuous schedules; this deployment explicitly runs the finite stages below.
  for (const scheduled of await boss.getSchedules()) if (scheduled.name.startsWith("cron.")) await boss.unschedule(scheduled.name);
  await registerContentJobs(boss);
  if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
  await registerEventJobs(boss);
  await registerNotifyJobs(boss);
  await registerPublicationJobs(boss);
  heartbeat = startHeartbeat("worker");
  await recordRun("batch.recover", async()=>({stale:await markStalePendingReceipts(),released:await autoReleaseUnknownReceipts()}));
  if (process.env.COLLECT_ENABLED !== "false") await recordRun("sources.schedule",scheduleDueSources);
  await recordRun("content.sweep",sweepUnprocessed);
  let quiet = 0;
  while (Date.now() < deadline - 240_000 && quiet < 3) {
    const [row] = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active') AND start_after <= now() + interval '90 seconds'`;
    quiet = row.n === 0 ? quiet + 1 : 0;
    await delay(10_000);
  }
  if (Date.now() < deadline - 240_000) {
    await recordRun("hot.rank",computeHotRanking);
    await recordRun("hot.snapshot",snapshotHeat);
    await recordRun("stories.status",refreshStoryStatuses);
    await recordRun("stories.links",linkRelatedStories);
    if (process.env.MODEL_CALLS_ENABLED === "true") await recordRun("reports.catch-up",()=>catchUpReports());
  }
  const [retention] = await sql<{at:Date|null}[]>`SELECT max(finished_at) AS at FROM job_runs WHERE job='ops.retention' AND status='ok'`;
  if (!retention.at || Date.now()-retention.at.getTime()>86400_000) await recordRun("ops.retention",()=>dailyRetention());
  const [size] = await sql<{bytes:number}[]>`SELECT pg_database_size(current_database()) AS bytes`;
  console.log(JSON.stringify({stage:"batch.finished",databaseBytes:size.bytes,warning:size.bytes>400_000_000 ? "database-near-free-limit" : null}));
  clearTimeout(hardStop);
  await shutdown();
} catch(error) {
  // Receipt records carry details. Avoid printing provider errors containing URLs or credentials.
  console.error(JSON.stringify({stage:"batch.failed",error:error instanceof Error ? error.name : "Error"}));
  await shutdown(1);
}
