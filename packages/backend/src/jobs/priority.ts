import { sql, type Db } from "../db.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
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

/** Expected waiting must not fail the whole batch and skip free maintenance. */
export async function runWithBudgetWaiting<T>(run: () => Promise<T>): Promise<T | { waiting: true; reason: string; retryAt: Date | null }> {
  try { return await run(); }
  catch (error) {
    if (error instanceof BudgetExceededError) {
      const budget = await readServiceBudget(error.service);
      return { waiting: true, reason: "budget", retryAt: budget.retryAt };
    }
    if (error instanceof ReceiptBusyError) return { waiting: true, reason: "receipt-busy", retryAt: new Date(Date.now()+60_000) };
    throw error;
  }
}
