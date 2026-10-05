// Waiting for a budget window or an existing receipt is durable work, not a failed model response.
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { readServiceBudget } from "../providers/budget.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { enqueue, QUEUES } from "./queue.ts";

export type EventQueue = typeof QUEUES.group | typeof QUEUES.digest;
export type EventPayload = { articleId: string; signalOnly?: boolean; force?: boolean } | { storyId: number; afterCorrection?: boolean };
type WaitReason = { reason: "budget" | "busy"; service: string | null; message: string; retryAt: Date };
type Deferral = WaitReason & { queue: EventQueue; job_key: string; payload: EventPayload; next_retry_at: Date };
type BudgetAvailability = (service: string, db: Db) => Promise<{ available: boolean; retryAt: Date | null }>;

const SERVICES = new Set(["llm", "deepseek", "zhipu", "mimo", "dashscope", "embedding"]);
const BUSY_DELAY_MS = 60_000;
const MAX_RETRY_MS = 24 * 3600_000;

/** No arbitrary model input or secrets from a failed job are admitted to the recovery table. */
function eventPayload(queue: EventQueue, raw: unknown): { payload: EventPayload; key: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid deferred event payload");
  const value = raw as Record<string, unknown>;
  if (queue === QUEUES.group) {
    if (Object.keys(value).some((key) => !["articleId", "signalOnly", "force"].includes(key)) ||
      typeof value.articleId !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.articleId) ||
      ["signalOnly", "force"].some((key) => value[key] !== undefined && typeof value[key] !== "boolean")) throw new Error("Invalid deferred grouping payload");
    return { key: value.articleId, payload: { articleId: value.articleId, ...(value.signalOnly === undefined ? {} : { signalOnly: value.signalOnly as boolean }), ...(value.force === undefined ? {} : { force: value.force as boolean }) } };
  }
  if (queue === QUEUES.digest) {
    if (Object.keys(value).some((key) => !["storyId", "afterCorrection"].includes(key)) ||
      !Number.isSafeInteger(value.storyId) || (value.storyId as number) <= 0 ||
      (value.afterCorrection !== undefined && typeof value.afterCorrection !== "boolean")) throw new Error("Invalid deferred digest payload");
    return { key: `story:${value.storyId}`, payload: { storyId: value.storyId as number, ...(value.afterCorrection === undefined ? {} : { afterCorrection: value.afterCorrection as boolean }) } };
  }
  throw new Error("Invalid deferred event queue");
}

function mergePayload(queue: EventQueue, old: EventPayload, next: EventPayload): EventPayload {
  if (queue === QUEUES.group) {
    const a = old as Extract<EventPayload, { articleId: string }>, b = next as typeof a;
    return { articleId: a.articleId, signalOnly: a.signalOnly === true && b.signalOnly === true, force: a.force === true || b.force === true };
  }
  const a = old as Extract<EventPayload, { storyId: number }>, b = next as typeof a;
  return { storyId: a.storyId, afterCorrection: a.afterCorrection === true || b.afterCorrection === true };
}

function waitReason(error: unknown, now: Date): WaitReason {
  if (error instanceof BudgetExceededError) {
    const delay = Math.min(MAX_RETRY_MS, Math.max(BUSY_DELAY_MS, error.retryAfterSeconds * 1000));
    const explicit = (error as BudgetExceededError & { retryAt?: Date }).retryAt;
    return { reason: "budget", service: error.service, message: error.message, retryAt: explicit instanceof Date && Number.isFinite(explicit.getTime()) && explicit > now ? explicit : new Date(now.getTime() + delay) };
  }
  if (error instanceof ReceiptBusyError) return { reason: "busy", service: null, message: error.message.slice(0, 500), retryAt: new Date(now.getTime() + BUSY_DELAY_MS) };
  throw error;
}

async function hasReusableReceipt(db: Db, queue: EventQueue, payload: EventPayload, service: string): Promise<boolean> {
  // A settled answer costs nothing to replay. This target-level hint does not replace paidRequest's
  // full logical-key check; a changed input still encounters the authoritative budget guard.
  const matches = queue === QUEUES.group
    ? await db`SELECT id FROM receipts WHERE service = ${service} AND status IN ('received', 'completed') AND response IS NOT NULL
        AND purpose IN ('group_article', 'group_review', 'group_signal')
        AND (subject = ${`article:${(payload as { articleId: string }).articleId}`} OR starts_with(subject, ${`article:${(payload as { articleId: string }).articleId}:fact:`})) LIMIT 1`
    : await db`SELECT id FROM receipts WHERE service = ${service} AND status IN ('received', 'completed') AND response IS NOT NULL
        AND purpose = 'story_digest' AND starts_with(subject, ${`story:${(payload as { storyId: number }).storyId}@`}) LIMIT 1`;
  return matches.length > 0;
}

async function lock(db: Db, queue: EventQueue, key: string): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtext(${`event-deferral:${queue}:${key}`}))`;
}

async function save(db: Db, queue: EventQueue, payload: EventPayload, key: string, wait: WaitReason, sourceJobId: string | null): Promise<Date> {
  await lock(db, queue, key);
  const [previous] = await db<{ payload: EventPayload; next_retry_at: Date; reason: WaitReason["reason"]; service: string | null; message: string }[]>`SELECT payload, next_retry_at, reason, service, message FROM event_job_deferrals WHERE queue = ${queue} AND job_key = ${key} FOR UPDATE`;
  const merged = previous ? mergePayload(queue, previous.payload, payload) : payload;
  // A later, still-blocked request must not be resumed by an earlier stale sweep.
  const retryAt = previous && previous.next_retry_at > wait.retryAt ? previous.next_retry_at : wait.retryAt;
  const retainedWait = previous && previous.next_retry_at > wait.retryAt ? previous : wait;
  await db`INSERT INTO event_job_deferrals (queue, job_key, payload, reason, service, message, next_retry_at, source_job_id)
    VALUES (${queue}, ${key}, ${db.json(merged as never)}, ${retainedWait.reason}, ${retainedWait.service}, ${retainedWait.message.slice(0, 500)}, ${retryAt}, ${sourceJobId})
    ON CONFLICT (queue, job_key) DO UPDATE SET payload = EXCLUDED.payload, reason = EXCLUDED.reason, service = EXCLUDED.service,
      message = EXCLUDED.message, next_retry_at = EXCLUDED.next_retry_at, source_job_id = coalesce(EXCLUDED.source_job_id, event_job_deferrals.source_job_id),
      deferral_count = event_job_deferrals.deferral_count + 1, updated_at = now()`;
  return retryAt;
}

/** Only these two errors are safe waits; unknown outcomes and invalid answers still fail normally. */
export async function deferEventJob(queue: EventQueue, raw: unknown, error: unknown, options: { sourceJobId?: string; now?: Date } = {}) {
  const wait = waitReason(error, options.now ?? new Date());
  const { payload, key } = eventPayload(queue, raw);
  const retryAt = await sql.begin((tx) => save(tx, queue, payload, key, wait, options.sourceJobId ?? null));
  return { state: "waiting" as const, reason: wait.reason, retryAt };
}

/** Enqueue and consume the wait atomically; competing sweeps and new corrections share the lock. */
export async function recoverDeferredEventJobs(options: { limit?: number; now?: Date; budget?: BudgetAvailability } = {}) {
  if (!config.modelCallsEnabled) return { enqueued: 0, retained: 0, missing: 0, disabled: true };
  const now = options.now ?? new Date(), limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const due = await sql<{ queue: EventQueue; job_key: string }[]>`SELECT queue, job_key FROM event_job_deferrals WHERE next_retry_at <= ${now} ORDER BY next_retry_at, created_at LIMIT ${limit}`;
  let enqueued = 0, retained = 0, missing = 0;
  for (const entry of due) {
    const result = await sql.begin(async (tx) => {
      await lock(tx, entry.queue, entry.job_key);
      const [row] = await tx<Deferral[]>`SELECT * FROM event_job_deferrals WHERE queue = ${entry.queue} AND job_key = ${entry.job_key} AND next_retry_at <= ${now} FOR UPDATE`;
      if (!row) return "gone";
      const { payload, key } = eventPayload(row.queue, row.payload);
      const exists = row.queue === QUEUES.group
        ? await tx`SELECT id FROM articles WHERE id = ${(payload as { articleId: string }).articleId}`
        : await tx`SELECT id FROM stories WHERE id = ${(payload as { storyId: number }).storyId} AND merged_into IS NULL`;
      if (!exists.length) {
        await tx`DELETE FROM event_job_deferrals WHERE queue = ${row.queue} AND job_key = ${key}`;
        return "missing";
      }
      if (row.service) {
        const availability = await (options.budget ?? readServiceBudget)(row.service, tx);
        if (!availability.available && !(await hasReusableReceipt(tx, row.queue, payload, row.service))) {
          const retryAt = availability.retryAt && availability.retryAt > now ? availability.retryAt : new Date(now.getTime() + BUSY_DELAY_MS);
          await tx`UPDATE event_job_deferrals SET next_retry_at = ${retryAt}, updated_at = now() WHERE queue = ${row.queue} AND job_key = ${key}`;
          return "retained";
        }
      }
      const id = await enqueue(row.queue, payload, { singletonKey: key }, tx);
      if (!id) {
        await tx`UPDATE event_job_deferrals SET next_retry_at = ${new Date(now.getTime() + BUSY_DELAY_MS)}, updated_at = now() WHERE queue = ${row.queue} AND job_key = ${key}`;
        return "retained";
      }
      await tx`DELETE FROM event_job_deferrals WHERE queue = ${row.queue} AND job_key = ${key}`;
      return "enqueued";
    });
    if (result === "enqueued") enqueued += 1;
    else if (result === "retained") retained += 1;
    else if (result === "missing") missing += 1;
  }
  return { enqueued, retained, missing, disabled: false };
}

function legacyWait(output: unknown, now: Date): WaitReason | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const value = output as Record<string, unknown>;
  if (typeof value.message !== "string") return null;
  if (["Error", "BudgetExceededError"].includes(String(value.name)) && typeof value.service === "string" && SERVICES.has(value.service)) {
    const match = /^Budget for ([a-z]+) exhausted \((minute|hour|day|stopped)\)$/.exec(value.message);
    if (!match || match[1] !== value.service || typeof value.retryAfterSeconds !== "number" || !Number.isFinite(value.retryAfterSeconds) || value.retryAfterSeconds <= 0 || value.retryAfterSeconds > 86400) return null;
    // Re-check availability during the recovery sweep; an old failure's window may already be open.
    return { reason: "budget", service: value.service, message: value.message, retryAt: now };
  }
  if (["Error", "ReceiptBusyError"].includes(String(value.name)) && value.service === undefined && /^Receipt [1-9][0-9]* is in flight$/.test(value.message)) return { reason: "busy", service: null, message: value.message, retryAt: now };
  return null;
}

/** Import only recognizable safe waits from retained failed jobs, once per job, with an audit record. */
export async function importLegacyEventDeferrals(options: { limit?: number; now?: Date } = {}) {
  const now = options.now ?? new Date(), limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const candidates = await sql<{ id: string; name: EventQueue; data: unknown; output: unknown }[]>`
    SELECT j.id, j.name, j.data, j.output FROM pgboss.job j
    WHERE j.name IN (${QUEUES.group}, ${QUEUES.digest}) AND j.state = 'failed'
      AND j.output->>'name' IN ('Error', 'BudgetExceededError', 'ReceiptBusyError')
      AND (j.output->>'message' LIKE 'Budget for % exhausted (%)' OR j.output->>'message' ~ '^Receipt [1-9][0-9]* is in flight$')
      AND NOT EXISTS (SELECT 1 FROM event_job_deferral_imports i WHERE i.source_job_id = j.id)
    ORDER BY j.completed_on, j.id LIMIT ${limit}`;
  let imported = 0, skipped = 0;
  for (const job of candidates) {
    const wait = legacyWait(job.output, now);
    let parsed: ReturnType<typeof eventPayload>;
    try { parsed = eventPayload(job.name, job.data); } catch { skipped += 1; continue; }
    if (!wait) { skipped += 1; continue; }
    const didImport = await sql.begin(async (tx) => {
      // The marker and wait commit together. A second import cannot resurrect completed recovery.
      const inserted = await tx`INSERT INTO event_job_deferral_imports (source_job_id, queue, job_key) VALUES (${job.id}, ${job.name}, ${parsed.key}) ON CONFLICT DO NOTHING RETURNING source_job_id`;
      if (!inserted.length) return false;
      await save(tx, job.name, parsed.payload, parsed.key, wait, job.id);
      await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
        VALUES ('ops.recover', 'event.defer.import', ${`job:${job.id}`}, '恢复预算或回执占用导致的历史事件任务',
          ${tx.json({ queue: job.name, state: "failed", reason: wait.reason } as never)},
          ${tx.json({ queue: job.name, key: parsed.key, state: "waiting" } as never)})`;
      return true;
    });
    if (didImport) imported += 1;
  }
  return { imported, skipped };
}
