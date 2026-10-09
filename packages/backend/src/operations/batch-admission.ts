// All trigger paths share one database admission window. Rejected runs never move its timestamp.
import { sql, type Db } from "../db.ts";

export const BATCH_ADMISSION_KEY = "ops.batch-admission";
export const DEFAULT_BATCH_INTERVAL_MINUTES = 55;

export interface BatchAdmissionOptions {
  /** The window cannot be shortened below the standard hourly-run safeguard. */
  intervalMinutes?: number;
  source?: "github-actions" | "cloudflare-cron" | "local";
  /** GitHub's numeric run identifier; never a URL, credential or arbitrary error message. */
  ownerRunId?: string;
}

export interface BatchAdmission {
  admitted: boolean;
  admittedAt: Date;
  nextEligibleAt: Date;
}

function admissionOptions(options: BatchAdmissionOptions) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["intervalMinutes", "source", "ownerRunId"].includes(key))) {
    throw new TypeError("Invalid batch admission options");
  }
  const intervalMinutes = options.intervalMinutes === undefined ? DEFAULT_BATCH_INTERVAL_MINUTES : options.intervalMinutes;
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < DEFAULT_BATCH_INTERVAL_MINUTES || intervalMinutes > 1440) {
    throw new RangeError("Batch interval must be an integer between 55 and 1440 minutes");
  }
  if (options.source !== undefined && !["github-actions", "cloudflare-cron", "local"].includes(options.source)) {
    throw new TypeError("Invalid batch admission source");
  }
  if (options.ownerRunId !== undefined && (typeof options.ownerRunId !== "string" || !/^[1-9][0-9]{0,19}$/.test(options.ownerRunId))) {
    throw new TypeError("Invalid batch admission run identifier");
  }
  return { version: 1, intervalMinutes,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.ownerRunId !== undefined ? { ownerRunId: options.ownerRunId } : {}) };
}

/**
 * The INSERT's unique-key conflict serializes competing triggers, including a missing first row.
 * updated_at is the last accepted run's DB clock; legacy/malformed JSON cannot bypass the window.
 * A failed accepted run keeps its claim, and can be retried once the normal window has elapsed.
 * No release/override path is provided. Database/configuration errors propagate and fail closed.
 */
export async function admitBatch(options: BatchAdmissionOptions = {}, db: Db = sql): Promise<BatchAdmission> {
  const value = admissionOptions(options);
  const rows = await db<{ admittedAt: Date; nextEligibleAt: Date }[]>`
    INSERT INTO settings AS existing (key, value, updated_by, updated_at)
    VALUES (${BATCH_ADMISSION_KEY}, ${db.json(value as never)}, 'system:batch-admission', clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
    WHERE existing.updated_at <= clock_timestamp() - make_interval(mins => ${value.intervalMinutes})
    RETURNING updated_at AS "admittedAt", updated_at + make_interval(mins => ${value.intervalMinutes}) AS "nextEligibleAt"`;
  const admitted = rows.length === 1;
  // A new statement observes the concurrent winner after the INSERT has waited for its row lock.
  const [row] = admitted ? rows : await db<{ admittedAt: Date; nextEligibleAt: Date }[]>`
    SELECT updated_at AS "admittedAt", updated_at + make_interval(mins => ${value.intervalMinutes}) AS "nextEligibleAt"
    FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  if (!row || !(row.admittedAt instanceof Date) || !(row.nextEligibleAt instanceof Date)
    || !Number.isFinite(row.admittedAt.getTime()) || !Number.isFinite(row.nextEligibleAt.getTime())) {
    throw new Error("Batch admission state unavailable");
  }
  return { admitted, admittedAt: row.admittedAt, nextEligibleAt: row.nextEligibleAt };
}
