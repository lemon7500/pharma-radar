import { beijingDate, isValidDate } from "@aihot/contracts/time";
import type { Bibliography } from "@aihot/contracts/research";

/** Source date bytes retained beside the accepted instant; no precision is inferred from a journal name. */
export interface SourcePublicationTime {
  value: string;
  unit?: "epoch_s" | "epoch_ms" | "yyyymmdd";
  at: string;
  precision: "day" | "time";
  date: string;
}

/** Reject impossible calendar days before JavaScript silently rolls them into the next month. */
export function parseSourcePublishedAt(value: unknown, unit?: string): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (unit === "epoch_s" || unit === "epoch_ms") {
    const at = new Date(Number(text) * (unit === "epoch_s" ? 1000 : 1));
    return Number.isFinite(at.getTime()) ? at : null;
  }
  if (unit === "yyyymmdd") {
    if (!/^\d{8}$/.test(text)) return null;
    const day = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return isValidDate(day) ? new Date(day) : null;
  }
  const calendar = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(text);
  if (calendar && !isValidDate(`${calendar[1]}-${calendar[2]!.padStart(2, "0")}-${calendar[3]!.padStart(2, "0")}`)) return null;
  const at = new Date(text);
  return Number.isFinite(at.getTime()) ? at : null;
}

export function sourcePublicationTime(value: unknown, accepted: Date | null | undefined, unit?: string): SourcePublicationTime | null {
  if (!accepted || !Number.isFinite(accepted.getTime()) || (typeof value !== "string" && typeof value !== "number")) return null;
  const text = String(value).trim();
  if (!text || text.length > 200) return null;
  const epoch = unit === "epoch_s" || unit === "epoch_ms";
  const day = unit === "yyyymmdd" && /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  const parsed = parseSourcePublishedAt(text, unit);
  if (!parsed || parsed.getTime() !== accepted.getTime()) return null;
  if (day && isValidDate(day)) return { value: text, ...(unit === "yyyymmdd" ? { unit } : {}), at: accepted.toISOString(), precision: "day", date: day };
  if (!epoch && !/\d{1,2}:\d{2}/.test(text)) return null;
  return { value: text, ...(epoch ? { unit: unit as "epoch_s" | "epoch_ms" } : {}), at: accepted.toISOString(), precision: "time", date: beijingDate(accepted) };
}

/** Validate stored metadata against the accepted source instant, not an arrival or rejected future claim. */
export function storedSourcePublicationTime(value: unknown, accepted: Date | null | undefined): SourcePublicationTime | null {
  if (!value || typeof value !== "object" || !accepted || !Number.isFinite(accepted.getTime())) return null;
  const record = value as Record<string, unknown>;
  if (record.at !== accepted.toISOString()) return null;
  return sourcePublicationTime(record.value, accepted, typeof record.unit === "string" ? record.unit : undefined);
}

export function precisePublicationTime(instant: Date): string {
  const shifted = new Date(instant.getTime() + 8 * 3600 * 1000).toISOString();
  return `${shifted.slice(0, 19)}${instant.getUTCMilliseconds() ? shifted.slice(19, 23) : ""}+08:00`;
}

/** Model steps share the same source-date expression. Unknown publication never falls back to arrival. */
export function editorialPublicationTime(item: {
  publishedAt: Date | null;
  bibliography?: Bibliography | null;
  sourcePublicationTime?: SourcePublicationTime | null;
}, now = new Date()): string | null {
  const validDay = (value: string | null | undefined): string | null => value && isValidDate(value) && value <= beijingDate(now) ? value : null;
  const instant = item.publishedAt && Number.isFinite(item.publishedAt.getTime()) && item.publishedAt <= now ? item.publishedAt : null;
  const bibliographicDay = validDay(item.bibliography?.publishedDate);
  const explicit = storedSourcePublicationTime(item.sourcePublicationTime, instant);
  const withClock = (at: Date): string => {
    const localDay = beijingDate(at), utcDay = at.toISOString().slice(0, 10);
    if (bibliographicDay && bibliographicDay !== localDay) {
      // A UTC / Beijing date boundary can explain a one-day difference; never splice a date and clock.
      if (bibliographicDay === utcDay) return `${precisePublicationTime(at)}（书目日期：${bibliographicDay}）`;
      return bibliographicDay;
    }
    return precisePublicationTime(at);
  };
  if (explicit?.precision === "time") return withClock(instant!);
  if (explicit?.precision === "day") return bibliographicDay ?? validDay(explicit.date);
  if (instant) {
    // Legacy collectors lost precision. Hide only their UTC / UTC+8 midnight placeholders.
    const utc = instant.toISOString().slice(11, 23);
    if (utc !== "00:00:00.000" && utc !== "16:00:00.000") return withClock(instant);
    return bibliographicDay ?? beijingDate(instant);
  }
  return bibliographicDay;
}
