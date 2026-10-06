import { sql, type Db } from "../db.ts";
import { BackgroundReserveExceededError, BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { readServiceBudget } from "../providers/budget.ts";
import { QUEUES } from "./queue.ts";

export const ARTICLE_QUEUES = [QUEUES.fetchSource, QUEUES.fetchXShard, QUEUES.mpCheck,
  QUEUES.extractBody, QUEUES.analyze, QUEUES.republishSource];
export const EVENT_QUEUES = [QUEUES.group, QUEUES.digest];

/** Only ready/active work blocks the finite run; future retries remain durable for later runs. */
export async function pendingPriorityWork(names: string[], db: Db = sql): Promise<number> {
  const [row] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job
    WHERE name=ANY(${names}::text[]) AND (state='active' OR
      (state IN ('created','retry') AND start_after <= now() + interval '90 seconds'))`;
  if (!names.includes(QUEUES.analyze)) return row!.n;
  // Budget/receipt waits finish their queue job and keep the retry on the article itself.
  // Include near-due unqueued articles so a quiet queue cannot bypass new-material priority.
  const [retries] = await db<{n:number}[]>`SELECT count(*)::int AS n FROM articles
    WHERE processing_state='new' AND (created_at < now() - interval '3 minutes' OR processing_retry_at IS NOT NULL)
      AND (processing_retry_at IS NULL OR processing_retry_at <= now() + interval '90 seconds')
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - interval '30 minutes')`;
  return row!.n + retries!.n;
}

/** First-time historical imports cannot hold the recent-publication/event phase open forever. */
export async function pendingRecentPriorityWork(names: string[] = ARTICLE_QUEUES, db: Db = sql): Promise<number> {
  const articleQueues = names.filter(name => [QUEUES.analyze, QUEUES.extractBody].includes(name as typeof QUEUES.analyze));
  const freeOrEventQueues = names.filter(name => !articleQueues.includes(name));
  const [queued] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job j
    LEFT JOIN articles a ON a.id = j.data->>'articleId' LEFT JOIN sources s ON s.id = a.source_id
    WHERE (j.state = 'active' OR (j.state IN ('created', 'retry') AND j.start_after <= now()))
      AND (j.name = ANY(${freeOrEventQueues}::text[]) OR (j.name = ANY(${articleQueues}::text[])
        AND NOT (j.data ? 'attemptTag') AND s.participation_mode = 'editorial'
        AND a.published_at >= now() - interval '48 hours' AND a.published_at <= now()))`;
  if (!names.includes(QUEUES.analyze)) return queued!.n;
  const [unqueued] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.processing_state = 'new' AND s.participation_mode = 'editorial'
      AND a.published_at >= now() - interval '48 hours' AND a.published_at <= now()
      AND (a.created_at < now() - interval '3 minutes' OR a.processing_retry_at IS NOT NULL)
      AND (a.processing_retry_at IS NULL OR a.processing_retry_at <= now())
      AND (a.processing_queued_at IS NULL OR a.processing_queued_at < now() - interval '30 minutes')`;
  return queued!.n + unqueued!.n;
}

/** Expected waiting must not fail the whole batch and skip free maintenance. */
export async function runWithBudgetWaiting<T>(run: () => Promise<T>): Promise<T | { waiting: true; reason: string; retryAt: Date | null }> {
  try { return await run(); }
  catch (error) {
    if (error instanceof BudgetExceededError) {
      const budget = await readServiceBudget(error.service);
      return { waiting: true, reason: error instanceof BackgroundReserveExceededError ? "background-reserve" : "budget", retryAt: error.retryAt ?? budget.retryAt };
    }
    if (error instanceof ReceiptBusyError) return { waiting: true, reason: "receipt-busy", retryAt: new Date(Date.now()+60_000) };
    throw error;
  }
}
