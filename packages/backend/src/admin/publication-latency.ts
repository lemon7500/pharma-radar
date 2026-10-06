import { sql, type Db } from "../db.ts";

export interface PublicationLatency {
  waiting: { count:number; recentCount:number; historicalOrUnknownCount:number; oldestDiscoveredAt:Date|null; oldestWaitMinutes:number|null };
  firstPublic: { sampleCount:number; p50Minutes:number|null; p95Minutes:number|null };
  indexOnly: { count:number; recentCount:number; historicalOrUnknownCount:number; oldestFirstPublicAt:Date|null; oldestAgeMinutes:number|null; untrackedCount:number };
}

/** First-public samples use observed release timestamps, never publication dates or projection updates. */
export async function publicationLatency(now = new Date(), db: Db = sql): Promise<PublicationLatency> {
  const [row] = await db<{
    waiting:number; waiting_recent:number; waiting_oldest:Date|null; waiting_minutes:number|null;
    samples:number; p50:number|null; p95:number|null;
    index_only:number; index_recent:number; index_oldest:Date|null; index_minutes:number|null; index_untracked:number;
  }[]>`
    WITH scope AS (
      SELECT a.discovered_at,a.published_at,a.processing_state,p.first_public_at,p.index_only,
        coalesce(p.eligible AND p.visibility='public' AND (NOT p.selected OR p.visible_after<=${now} OR p.first_public_at<=${now}),false) AS public_now,
        coalesce(a.published_at BETWEEN ${new Date(now.getTime()-48*3600_000)} AND ${now},false) AS recent
      FROM articles a JOIN sources s ON s.id=a.source_id
      LEFT JOIN publications p ON p.article_id=a.id
      LEFT JOIN editorial_overrides e ON e.article_id=a.id
      WHERE s.participation_mode='editorial' AND a.canonical_article_id IS NULL
        AND coalesce(p.visibility,'public')<>'withdrawn' AND coalesce(e.visibility,'public')<>'withdrawn'
    ), classified AS (
      SELECT *,NOT public_now AND processing_state<>'blocked' AS awaiting,
        first_public_at BETWEEN ${new Date(now.getTime()-7*86400_000)} AND ${now}
        AND first_public_at>=discovered_at AS sample,
        public_now AND index_only AS pending_index
      FROM scope
    )
    SELECT count(*) FILTER(WHERE awaiting)::int AS waiting,
      count(*) FILTER(WHERE awaiting AND recent)::int AS waiting_recent,
      min(discovered_at) FILTER(WHERE awaiting) AS waiting_oldest,
      greatest(extract(epoch FROM ${now}-min(discovered_at) FILTER(WHERE awaiting))/60,0)::double precision AS waiting_minutes,
      count(*) FILTER(WHERE sample)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM first_public_at-discovered_at)/60) FILTER(WHERE sample) AS p50,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM first_public_at-discovered_at)/60) FILTER(WHERE sample) AS p95,
      count(*) FILTER(WHERE pending_index)::int AS index_only,
      count(*) FILTER(WHERE pending_index AND recent)::int AS index_recent,
      min(first_public_at) FILTER(WHERE pending_index AND first_public_at<=${now}) AS index_oldest,
      greatest(extract(epoch FROM ${now}-min(first_public_at) FILTER(WHERE pending_index AND first_public_at<=${now}))/60,0)::double precision AS index_minutes,
      count(*) FILTER(WHERE pending_index AND first_public_at IS NULL)::int AS index_untracked
    FROM classified`;
  return {
    waiting:{count:row!.waiting,recentCount:row!.waiting_recent,historicalOrUnknownCount:row!.waiting-row!.waiting_recent,
      oldestDiscoveredAt:row!.waiting_oldest,oldestWaitMinutes:row!.waiting_oldest ? row!.waiting_minutes : null},
    firstPublic:{sampleCount:row!.samples,p50Minutes:row!.p50,p95Minutes:row!.p95},
    indexOnly:{count:row!.index_only,recentCount:row!.index_recent,historicalOrUnknownCount:row!.index_only-row!.index_recent,
      oldestFirstPublicAt:row!.index_oldest,oldestAgeMinutes:row!.index_oldest ? row!.index_minutes : null,untrackedCount:row!.index_untracked},
  };
}
