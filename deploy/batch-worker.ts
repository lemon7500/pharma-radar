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
import { backfillResearch } from "@aihot/backend/research/backfill";
import { readServiceBudget } from "@aihot/backend/providers/budget";
import { importLegacyEventDeferrals, recoverDeferredEventJobs } from "@aihot/backend/jobs/event-deferrals";
import { ARTICLE_QUEUES, EVENT_QUEUES, pendingPriorityWork, runWithBudgetWaiting } from "@aihot/backend/jobs/priority";

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
async function drain(names: string[]) {
  let quiet = 0, lastSweep = Date.now();
  while (Date.now() < deadline - 240_000 && quiet < 3) {
    if (names.includes('content.analyze') && Date.now()-lastSweep >= 30_000) {
      await sweepUnprocessed();
      lastSweep = Date.now();
    }
    quiet = await pendingPriorityWork(names) === 0 ? quiet + 1 : 0;
    await delay(10_000);
  }
  return await pendingPriorityWork(names) === 0;
}
try {
  const boss = await getBoss();
  // Disable legacy continuous schedules; this deployment explicitly runs the finite stages below.
  for (const scheduled of await boss.getSchedules()) if (scheduled.name.startsWith("cron.")) await boss.unschedule(scheduled.name);
  await registerContentJobs(boss);
  if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
  await registerNotifyJobs(boss);
  await registerPublicationJobs(boss);
  heartbeat = startHeartbeat("worker");
  await recordRun("batch.recover", async()=>({stale:await markStalePendingReceipts(),released:await autoReleaseUnknownReceipts()}));
  if (process.env.COLLECT_ENABLED !== "false") await recordRun("sources.schedule",scheduleDueSources);
  await recordRun("content.sweep",sweepUnprocessed);
  // Queue priorities only apply within one queue. Register model-consuming event handlers
  // after new material is processed, so event digests do not take its remaining allowance.
  const articlesDrained = await drain(ARTICLE_QUEUES);
  await recordRun("events.recover", async () => ({
    legacy: await importLegacyEventDeferrals(),
    deferred: articlesDrained && Date.now() < deadline - 240_000
      ? await recoverDeferredEventJobs({budget:readServiceBudget})
      : {waiting:true,reason:"priority-work"},
  }));
  if (articlesDrained && Date.now() < deadline - 240_000) {
    await registerEventJobs(boss);
    await drain([...ARTICLE_QUEUES,...EVENT_QUEUES]);
  }
  if (Date.now() < deadline - 240_000) {
    await recordRun("hot.rank",computeHotRanking);
    await recordRun("hot.snapshot",snapshotHeat);
    await recordRun("stories.status",refreshStoryStatuses);
    await recordRun("stories.links",linkRelatedStories);
    if (process.env.MODEL_CALLS_ENABLED === "true") await recordRun("reports.catch-up", async () =>
      await pendingPriorityWork([...ARTICLE_QUEUES,...EVENT_QUEUES])
        ? {waiting:true,reason:"priority-work"}
        : runWithBudgetWaiting(()=>catchUpReports()));
  }
  const [retention] = await sql<{at:Date|null}[]>`SELECT max(finished_at) AS at FROM job_runs WHERE job='ops.retention' AND status='ok'`;
  if (Date.now() < deadline - 240_000) await recordRun("research.backfill", async () =>
    await pendingPriorityWork([...ARTICLE_QUEUES,...EVENT_QUEUES])
      ? {waiting:true,reason:"priority-work"}
      : backfillResearch({ deadline, limit: Number(process.env.RESEARCH_BACKFILL_LIMIT || 20) }));
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
