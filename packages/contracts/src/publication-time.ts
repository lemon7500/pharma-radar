import { beijingDate, beijingTime, isValidDate } from "./time.ts";

export interface PublicationTime {
  date: string | null;
  time: string | null;
  precision: "day" | "time" | "unknown";
}

/** Bibliographic dates are calendar dates, not midnight instants. Never use arrival as publication. */
export function publicationTime(item: { publishedAt: string | null; research?: { bibliography: { publishedDate: string | null } } | null }, now = new Date()): PublicationTime {
  const day = item.research?.bibliography.publishedDate;
  if (day && isValidDate(day) && day <= beijingDate(now)) return { date: day, time: null, precision: "day" };
  const instant = item.publishedAt ? new Date(item.publishedAt) : null;
  if (!instant || !Number.isFinite(instant.getTime()) || instant > now) return { date: null, time: null, precision: "unknown" };
  // Older sources encoded date-only values as midnight UTC or midnight UTC+8.
  // Without an explicit precision field, hide these clocks rather than inventing one.
  const midnight = instant.toISOString().slice(11, 23) === "00:00:00.000" || beijingTime(instant) === "00:00";
  return { date: beijingDate(instant), time: midnight ? null : beijingTime(instant), precision: midnight ? "day" : "time" };
}

export function publicationLabel(value: PublicationTime): string {
  return value.date ? `${value.date}${value.time ? ` ${value.time} (UTC+08:00)` : ""}` : "发表时间待确认";
}
