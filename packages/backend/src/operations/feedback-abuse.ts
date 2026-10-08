// A short database lock makes admission atomic; uploads never hold a transaction open.
import { randomUUID } from "node:crypto";
import { sql, type Tx } from "../db.ts";
import { durableStorageConfigured, removeDurableFile } from "./durable-files.ts";
import { FeedbackRejected } from "./feedback.ts";

const MiB = 1024 * 1024;
export const FEEDBACK_MAX_IMAGE_BYTES = 5 * MiB;
const OLD_IMAGE_MAX_BYTES = 8 * MiB;
const LEASE_SECONDS = 120;

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const feedbackLimits = () => ({
  perMinute: limit("FEEDBACK_PER_MINUTE", 5),
  perDay: limit("FEEDBACK_PER_DAY", 20),
  totalPerDay: limit("FEEDBACK_TOTAL_PER_DAY", 100),
  storageBytes: limit("FEEDBACK_STORAGE_MAX_BYTES", 100 * MiB),
  uploadDailyBytes: limit("FEEDBACK_UPLOAD_DAILY_BYTES", 50 * MiB),
  concurrent: Math.min(16, limit("FEEDBACK_MAX_CONCURRENT", 2)),
  perIpConcurrent: Math.min(16, limit("FEEDBACK_PER_IP_CONCURRENT", 1)),
  bodyTimeoutMs: Math.min(30_000, limit("FEEDBACK_BODY_TIMEOUT_MS", 30_000)),
});

async function admissionLock(tx: Tx) {
  await tx`SELECT pg_advisory_xact_lock(714032, 1)`;
}

async function storageBytes(tx: Tx): Promise<number> {
  const [row] = await tx<{ bytes: number }[]>`
    SELECT (SELECT coalesce(sum(coalesce(screenshot_bytes, ${OLD_IMAGE_MAX_BYTES})), 0) FROM feedback WHERE screenshot_key LIKE 'local:%')
      + (SELECT coalesce(sum(screenshot_bytes), 0) FROM feedback_submission_attempts WHERE state = 'pending' OR cleanup_needed) AS bytes`;
  return row!.bytes;
}

async function dailyUploadBytes(tx: Tx): Promise<number> {
  const [row] = await tx<{ bytes: number }[]>`
    SELECT coalesce(sum(screenshot_bytes), 0) AS bytes FROM feedback_submission_attempts
    WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      AND (state = 'pending' OR storage_key IS NOT NULL)`;
  return row!.bytes;
}

export interface FeedbackReservation { id: string; source: string; submissionId: string; }
type Admission = { feedbackId: number } | { reservation: FeedbackReservation };

/** Request counters last two days, idempotency receipts seven days. Unremoved files retain their accounting. */
async function prune(tx: Tx) {
  await tx`UPDATE feedback_submission_attempts SET state = 'failed', cleanup_needed = storage_key IS NOT NULL,
    screenshot_bytes = CASE WHEN storage_key IS NULL THEN 0 ELSE screenshot_bytes END, finished_at = now()
    WHERE state = 'pending' AND lease_until <= now()`;
  await tx`DELETE FROM feedback_submission_receipts WHERE updated_at < now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM feedback_submission_attempts a WHERE a.id = active_attempt AND (a.state = 'pending' OR a.cleanup_needed))`;
  await tx`DELETE FROM feedback_submission_attempts WHERE created_at < now() - interval '2 days' AND state <> 'pending' AND NOT cleanup_needed`;
}

export async function reserveFeedback(source: string, legacySource: string, submissionId: string, payloadHash: string, bytes: number): Promise<Admission> {
  return sql.begin(async (tx) => {
    await admissionLock(tx);
    await prune(tx);
    const [banned] = await tx`SELECT 1 FROM feedback_bans WHERE source_hash IN (${source}, ${legacySource})`;
    if (banned) throw new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
    const [receipt] = await tx<{ payload_hash: string; feedback_id: number | null; state: string | null }[]>`
      SELECT r.payload_hash, r.feedback_id, a.state FROM feedback_submission_receipts r
      LEFT JOIN feedback_submission_attempts a ON a.id = r.active_attempt
      WHERE r.source_hash = ${source} AND r.submission_id = ${submissionId}::uuid`;
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new FeedbackRejected(409, "submission_conflict", "这次提交编号已用于另一份反馈，请刷新页面后重新提交。");
      if (receipt.feedback_id !== null) return { feedbackId: receipt.feedback_id };
      if (receipt.state === "pending") throw new FeedbackRejected(409, "submission_pending", "这份反馈正在处理，请稍后重试。", 5);
    }
    const caps = feedbackLimits();
    const [counts] = await tx<{ minute: number; day: number; total: number; active: number }[]>`
      SELECT count(*) FILTER (WHERE source_hash = ${source} AND created_at > now() - interval '1 minute')::int AS minute,
        count(*) FILTER (WHERE source_hash = ${source} AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS day,
        count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS total,
        count(*) FILTER (WHERE state = 'pending')::int AS active FROM feedback_submission_attempts`;
    if (counts!.minute >= caps.perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请一分钟后重试。", 60);
    if (counts!.day >= caps.perDay || counts!.total >= caps.totalPerDay) throw new FeedbackRejected(429, "daily_limit", "今天的反馈提交额度已用完，请明天再试。", 3600);
    if (counts!.active >= caps.concurrent) throw new FeedbackRejected(429, "busy", "反馈服务正忙，请稍后重试。", 10);
    if (bytes && ((await storageBytes(tx)) + bytes > caps.storageBytes || (await dailyUploadBytes(tx)) + bytes > caps.uploadDailyBytes)) {
      throw new FeedbackRejected(429, "upload_limit", "截图上传额度暂时不足，可以移除截图后发送文字反馈。", 3600);
    }
    const id = randomUUID();
    await tx`INSERT INTO feedback_submission_attempts (id, source_hash, state, screenshot_bytes, lease_until)
      VALUES (${id}::uuid, ${source}, 'pending', ${bytes}, now() + ${LEASE_SECONDS} * interval '1 second')`;
    await tx`INSERT INTO feedback_submission_receipts (source_hash, submission_id, payload_hash, active_attempt)
      VALUES (${source}, ${submissionId}::uuid, ${payloadHash}, ${id}::uuid)
      ON CONFLICT (source_hash, submission_id) DO UPDATE SET active_attempt = excluded.active_attempt, updated_at = now()`;
    return { reservation: { id, source, submissionId } };
  }) as Promise<Admission>;
}

/** Re-encoding can change size, so update the reservation atomically before writing any bytes. */
export async function prepareFeedbackUpload(reservation: FeedbackReservation, bytes: number, storageKey: string) {
  const remote = durableStorageConfigured();
  await sql.begin(async (tx) => {
    await admissionLock(tx);
    const [row] = await tx<{ screenshot_bytes: number }[]>`SELECT screenshot_bytes FROM feedback_submission_attempts
      WHERE id = ${reservation.id}::uuid AND state = 'pending' AND lease_until > now() FOR UPDATE`;
    if (!row) throw new FeedbackRejected(409, "submission_expired", "本次提交已超时，请保留草稿并重新发送。", 5);
    const caps = feedbackLimits();
    const extra = bytes - row.screenshot_bytes;
    if ((await storageBytes(tx)) + extra > caps.storageBytes || (await dailyUploadBytes(tx)) + extra > caps.uploadDailyBytes) {
      throw new FeedbackRejected(429, "upload_limit", "截图上传额度暂时不足，可以移除截图后发送文字反馈。", 3600);
    }
    await tx`UPDATE feedback_submission_attempts SET screenshot_bytes = ${bytes}, storage_key = ${storageKey}, storage_remote = ${remote}
      WHERE id = ${reservation.id}::uuid`;
  });
}

export async function finishFeedback(reservation: FeedbackReservation, input: { content: string; email: string | null; pageUrl: string | null; screenshotKey: string | null; screenshotBytes: number }): Promise<number> {
  return sql.begin(async (tx) => {
    const [attempt] = await tx<{ id: string; storage_remote: boolean }[]>`SELECT id, storage_remote FROM feedback_submission_attempts
      WHERE id = ${reservation.id}::uuid AND state = 'pending' AND lease_until > now() FOR UPDATE`;
    if (!attempt) throw new FeedbackRejected(409, "submission_expired", "本次提交已超时，请保留草稿并重新发送。", 5);
    const [row] = await tx<{ id: number }[]>`INSERT INTO feedback (content, email, page_url, screenshot_key, screenshot_bytes, screenshot_remote, source_hash, forward_error)
      VALUES (${input.content}, ${input.email}, ${input.pageUrl}, ${input.screenshotKey}, ${input.screenshotBytes}, ${attempt.storage_remote}, ${reservation.source}, 'pending') RETURNING id`;
    await tx`UPDATE feedback_submission_attempts SET state = 'succeeded', finished_at = now() WHERE id = ${reservation.id}::uuid`;
    await tx`UPDATE feedback_submission_receipts SET feedback_id = ${row!.id}, updated_at = now()
      WHERE source_hash = ${reservation.source} AND submission_id = ${reservation.submissionId}::uuid AND active_attempt = ${reservation.id}::uuid`;
    return row!.id;
  }) as Promise<number>;
}

export async function failFeedback(reservation: FeedbackReservation, storageKey: string | null) {
  // Check durable state before compensation: an uncertain commit may already have saved the feedback.
  const rows = await sql<{ storage_remote: boolean }[]>`UPDATE feedback_submission_attempts SET state = 'failed', finished_at = now(), cleanup_needed = ${storageKey !== null},
    screenshot_bytes = CASE WHEN ${storageKey === null} THEN 0 ELSE screenshot_bytes END
    WHERE id = ${reservation.id}::uuid AND state = 'pending' RETURNING storage_remote`;
  if (!rows.length || !storageKey || rows[0]!.storage_remote) return;
  try {
    await removeDurableFile(storageKey, { requireRemote: rows[0]!.storage_remote });
    await sql`UPDATE feedback_submission_attempts SET cleanup_needed = false WHERE id = ${reservation.id}::uuid AND state = 'failed'`;
  } catch { /* Keep its bytes reserved until a cleanup retry succeeds. */ }
}

/** Runs in the existing feedback maintenance job even when forwarding is disabled. */
export async function cleanupFeedbackUploads(): Promise<void> {
  await sql.begin(async (tx) => { await admissionLock(tx); await prune(tx); });
  const rows = await sql<{ id: string; storage_key: string; storage_remote: boolean }[]>`SELECT id, storage_key, storage_remote FROM feedback_submission_attempts
    WHERE cleanup_needed AND state = 'failed' AND storage_key IS NOT NULL AND lease_until <= now() ORDER BY created_at LIMIT 4`;
  await Promise.all(rows.map(async (row) => {
    try {
      await removeDurableFile(row.storage_key, { requireRemote: row.storage_remote });
      await sql`UPDATE feedback_submission_attempts SET cleanup_needed = false WHERE id = ${row.id}::uuid AND state = 'failed'`;
    } catch { /* A failed deletion must never silently release storage accounting. */ }
  }));
}
