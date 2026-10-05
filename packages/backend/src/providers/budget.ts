import { sql, type Db } from "../db.ts";

export interface BudgetLimits { per_minute: number; per_hour: number; per_day: number }
export interface ServiceBudget {
  available: boolean;
  blockedWindow: "minute" | "hour" | "day" | "stopped" | null;
  retryAt: Date | null;
  remaining: { minute: number; hour: number; day: number } | null;
}

/** Advisory scheduling only. paidRequest still checks under its service lock before sending. */
export function budgetSnapshot(limits: BudgetLimits | undefined, attempts: Date[], now: Date): ServiceBudget {
  if (!limits) return { available: true, blockedWindow: null, retryAt: null, remaining: null };
  const windows = [
    { key: "minute" as const, ms: 60_000, cap: limits.per_minute },
    { key: "hour" as const, ms: 3_600_000, cap: limits.per_hour },
    { key: "day" as const, ms: 86_400_000, cap: limits.per_day },
  ];
  const remaining = { minute: 0, hour: 0, day: 0 };
  let blockedWindow: ServiceBudget["blockedWindow"] = null, retry = 0;
  for (const window of windows) {
    const recent = attempts.map(a => a.getTime()).filter(t => t > now.getTime() - window.ms).sort((a,b) => a-b);
    remaining[window.key] = Math.max(0, window.cap - recent.length);
    if (window.cap <= 0) { blockedWindow = "stopped"; continue; }
    if (recent.length >= window.cap && blockedWindow !== "stopped") {
      blockedWindow ??= window.key;
      // Drop enough oldest attempts to make count strictly less than the cap.
      retry = Math.max(retry, recent[recent.length - window.cap]! + window.ms);
    }
  }
  return { available: blockedWindow === null, blockedWindow, remaining,
    retryAt: blockedWindow && blockedWindow !== "stopped" ? new Date(retry + 1000) : null };
}

export async function readServiceBudget(service: string, db: Db = sql): Promise<ServiceBudget> {
  const [limits] = await db<BudgetLimits[]>`SELECT per_minute,per_hour,per_day FROM budgets WHERE service=${service}`;
  if (!limits) return budgetSnapshot(undefined, [], new Date());
  const [clock] = await db<{ now: Date }[]>`SELECT now() AS now`;
  const attempts = await db<{ started_at: Date }[]>`SELECT started_at FROM receipt_attempts
    WHERE service=${service} AND origin='live' AND started_at > ${new Date(clock!.now.getTime()-86_400_000)}`;
  return budgetSnapshot(limits, attempts.map(a => a.started_at), clock!.now);
}
