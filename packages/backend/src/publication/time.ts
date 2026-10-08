import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { publicationTime, type PublicationTime } from "@aihot/contracts/publication-time";
import { storedSourcePublicationTime } from "../editorial/publication-time.ts";

/** The only source-aware public projection; neither raw source bytes nor private evidence are returned. */
export function publicPublicationTime(row: {
  published_at: Date | null;
  publication_date?: string | null;
  research?: { bibliography: { publishedDate: string | null } } | null;
  source_publication_time?: unknown;
}, now = new Date()): PublicationTime {
  const original = storedSourcePublicationTime(row.source_publication_time, row.published_at);
  return publicationTime({ publishedAt: row.published_at?.toISOString() ?? null,
    publishedDate: row.publication_date ?? row.research?.bibliography.publishedDate,
    sourcePrecision: original?.precision, sourceDate: original?.date }, now);
}

/** Opt-in reader ordering. Original clock bytes are checked before a cast or within-day sort. */
export function publicationOrderAt(now: Date) {
  const date = sql`p.research->'bibliography'->>'publishedDate'`;
  const clock = sql`source_clock.raw->'publicationTime'`;
  const value = sql`${clock}->>'value'`;
  const provedClock = sql`EXISTS (SELECT 1 FROM articles source_clock WHERE source_clock.id=p.article_id
    AND jsonb_typeof(${clock})='object' AND jsonb_typeof(${clock}->'value') IN ('string','number')
    AND length(${value}) BETWEEN 1 AND 200
    AND ${clock}->>'at'=to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND CASE WHEN ${clock}->>'unit' IN ('epoch_s','epoch_ms') THEN
      CASE WHEN ${value} ~ '^[+-]?(\\d{1,16}(\\.\\d{1,6})?|\\.\\d{1,6})([eE][+-]?\\d{1,2})?$' AND pg_input_is_valid(${value},'numeric') THEN
        CASE WHEN abs((${value})::numeric)<=CASE WHEN ${clock}->>'unit'='epoch_s' THEN 8640000000000 ELSE 8640000000000000 END THEN
          trunc((${value})::numeric * CASE WHEN ${clock}->>'unit'='epoch_s' THEN 1000 ELSE 1 END)=extract(epoch FROM p.published_at)*1000
          ELSE false END
        ELSE false END
      WHEN ${clock}->>'unit' IS DISTINCT FROM 'yyyymmdd' AND ${value} ~ '\\d{1,2}:\\d{2}' THEN
        CASE WHEN pg_input_is_valid(${value},'timestamp with time zone') THEN (${value})::timestamptz=p.published_at ELSE false END
      ELSE false END)`;
  const instantDay = sql`date_trunc('day',p.published_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`;
  const sourceTime = sql`CASE WHEN ${provedClock} THEN p.published_at ELSE ${instantDay} END`;
  return sql`CASE WHEN ${date} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND pg_input_is_valid(${date}, 'date') THEN
    CASE WHEN ${date} <= ${beijingDate(now)} THEN
      CASE WHEN p.published_at <= ${now} AND ${date}=to_char(p.published_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
        THEN ${sourceTime} ELSE (${date})::date::timestamp AT TIME ZONE 'Asia/Shanghai' END
      WHEN p.published_at <= ${now} THEN ${sourceTime} END
    WHEN p.published_at <= ${now} THEN ${sourceTime} END`;
}
