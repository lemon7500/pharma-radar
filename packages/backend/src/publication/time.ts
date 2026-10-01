import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";

/** Opt-in reader ordering. Legacy timeline_at and public v1/RSS/MCP remain unchanged. */
export function publicationOrderAt(now: Date) {
  const date = sql`p.research->'bibliography'->>'publishedDate'`;
  return sql`CASE WHEN ${date} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND pg_input_is_valid(${date}, 'date') THEN
    CASE WHEN ${date} <= ${beijingDate(now)} THEN (${date})::date::timestamp AT TIME ZONE 'Asia/Shanghai'
      WHEN p.published_at <= ${now} THEN p.published_at END
    WHEN p.published_at <= ${now} THEN p.published_at END`;
}
