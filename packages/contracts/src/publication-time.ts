import { beijingDate, beijingTime, isValidDate } from "./time.ts";

export interface PublicationTime {
  date: string | null;
  time: string | null;
  precision: "day" | "time" | "unknown";
}

/** Bibliographic dates are calendar dates, not midnight instants. Never use arrival as publication. */
export function publicationTime(item: {
  publishedAt: string | null;
  research?: { bibliography: { publishedDate: string | null } } | null;
  publishedDate?: string | null;
  /** Server validates the original source value against the accepted instant before setting these. */
  sourcePrecision?: "day" | "time";
  sourceDate?: string | null;
}, now = new Date()): PublicationTime {
  const validDay = (value: string | null | undefined) => value && isValidDate(value) && value <= beijingDate(now) ? value : null;
  const day = validDay(item.publishedDate ?? item.research?.bibliography.publishedDate);
  const instant = item.publishedAt ? new Date(item.publishedAt) : null;
  const accepted = instant && Number.isFinite(instant.getTime()) && instant <= now ? instant : null;
  const localDay = accepted ? beijingDate(accepted) : null;
  // A bibliographic correction wins over a conflicting timestamp. Never splice its day with a clock.
  if (day && (!accepted || day !== localDay || item.sourcePrecision !== "time")) return { date: day, time: null, precision: "day" };
  if (accepted && item.sourcePrecision === "time") return { date: localDay, time: beijingTime(accepted), precision: "time" };
  const date = day ?? validDay(item.sourcePrecision === "day" ? item.sourceDate : null) ?? localDay;
  // Normalized legacy timestamps alone do not prove that the source provided a clock (including midnight).
  return date ? { date, time: null, precision: "day" } : { date: null, time: null, precision: "unknown" };
}

export function publicationLabel(value: PublicationTime): string {
  return value.date ? `${value.date}${value.time ? ` ${value.time} (UTC+08:00)` : ""}` : "发表时间待确认";
}
