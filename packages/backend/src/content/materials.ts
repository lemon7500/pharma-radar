// The single entrance for new material from every channel (collectors, external reports, imports).
// It owns identity, revisions and the timeline rule, so no entrance can bypass them.
import { sql, type Db } from "../db.ts";
import { newArticleId, sha256 } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { collapseWhitespace } from "../lib/text.ts";
import type { Bibliography } from "@aihot/contracts/research";
import { normalizeBibliography, bibliographyPresent } from "../research/profile.ts";
import { storedSourcePublicationTime } from "../editorial/publication-time.ts";

export interface MediaItem {
  kind: "image" | "video";
  url: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  poster?: string | null;
}

export interface XPostData {
  tweetId: string;
  authorName: string;
  handle: string;
  avatarUrl?: string | null;
  text: string;
  quoted?: { authorName: string; handle: string; text: string; url: string; media?: MediaItem[] } | null;
  media?: MediaItem[];
  lang?: string | null;
  replyTo?: string | null;
}

export interface MaterialInput {
  bibliography?: Bibliography | null;
  sourceId: string;
  url: string;
  title: string;
  identityKey?: string;
  author?: string | null;
  language?: string | null;
  publishedAt?: Date | null;
  sourceUpdatedAt?: Date | null;
  excerpt?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyStatus?: "pending" | "ok" | "unconfirmed" | "none";
  media?: MediaItem[];
  xPost?: XPostData | null;
  raw?: unknown;
  via: "fetch" | "ingest" | "import";
  discoveredAt?: Date;
  /** Explicit backfill: first import of a new source, or a report flagged as backfill. */
  backfill?: string | null;
  /** Keep an existing id when importing history. */
  id?: string;
}

export interface MaterialResult {
  articleId: string;
  created: boolean;
  revised: boolean;
  backfill: boolean;
}

// Material first discovered more than this long after its source time is archived by source time,
// stays out of "today" and is never pushed. Must not be wider than the 72 h the v1 contract states.
export const STALE_ON_DISCOVERY_MS = 48 * 3600 * 1000;
// Source times more than an hour in the future are not trusted.
export const FUTURE_TOLERANCE_MS = 3600 * 1000;

export interface TimelineDecision {
  publishedAt: Date | null;
  timelineAt: Date;
  backfill: boolean;
  backfillReason: string | null;
}

/** The one timeline rule shared by every entrance. */
export function decideTimeline(claimed: Date | null | undefined, discoveredAt: Date, explicitBackfill?: string | null): TimelineDecision {
  let publishedAt: Date | null = claimed && Number.isFinite(claimed.getTime()) ? claimed : null;
  if (publishedAt && publishedAt.getTime() > discoveredAt.getTime() + FUTURE_TOLERANCE_MS) publishedAt = null;
  let backfillReason: string | null = null;
  if (explicitBackfill) backfillReason = explicitBackfill;
  else if (publishedAt && discoveredAt.getTime() - publishedAt.getTime() > STALE_ON_DISCOVERY_MS) backfillReason = "stale-on-discovery";
  const backfill = backfillReason !== null;
  const timelineAt = backfill && publishedAt ? publishedAt : discoveredAt;
  return { publishedAt, timelineAt, backfill, backfillReason };
}

/**
 * History rather than news: a backfill (a new source's first import, stale on discovery, flagged by
 * a report) whose source time is unknown or was already past the stale threshold when found. It is
 * archived and analysed like anything else, but waits behind live work and founds no event and adds
 * no heat (it stays out of the event graph). A new source's post from this morning is news.
 */
export function isHistorical(a: { backfill: boolean; published_at: Date | null; discovered_at: Date }): boolean {
  return a.backfill && (!a.published_at || a.discovered_at.getTime() - a.published_at.getTime() > STALE_ON_DISCOVERY_MS);
}

/** Identity of stored content: the revision changes exactly when this does. */
export function contentHash(c: { title: string; bodyText?: string | null; excerpt?: string | null }): string {
  return sha256([collapseWhitespace(c.title), collapseWhitespace(c.bodyText ?? ""), collapseWhitespace(c.excerpt ?? "")].join("\u0001"));
}

const LOST = "\uFFFD";

/**
 * Whether two renderings of a text differ only where a character was lost in transit: a U+FFFD (a run
 * of them, from an older decode) on either side stands for any one character. Some feeds garble a
 * few characters at random on every load, so no two loads of its articles are the same text.
 */
function sameBarringLoss(a: string | null | undefined, b: string | null | undefined): boolean {
  const chars = (s: string | null | undefined) => Array.from(collapseWhitespace(s ?? "").replace(/\uFFFD+/g, LOST));
  const x = chars(a);
  const y = chars(b);
  return x.length === y.length && x.every((c, i) => c === y[i] || c === LOST || y[i] === LOST);
}

export function identityKeyFor(m: MaterialInput): string {
  if (m.identityKey) return m.identityKey;
  if (m.xPost?.tweetId) return `x:${m.xPost.tweetId}`;
  const fromUrl = identityKeyForUrl(m.url);
  if (fromUrl) return fromUrl;
  return `src:${m.sourceId}:${sha256(m.url + "\u0001" + m.title).slice(0, 32)}`;
}

/**
 * Stores material. Existing identities get a discovery record, and a new revision only when the
 * stored content really changes. Concurrent reports of the same material are serialised on the row,
 * so every change gets its own revision number. Returns whether processing is needed.
 */
export async function upsertMaterial(m: MaterialInput, db: Db = sql): Promise<MaterialResult> {
  const run = (tx: Db) => upsertIn(tx, m);
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

async function upsertIn(db: Db, m: MaterialInput): Promise<MaterialResult> {
  let identityKey = identityKeyFor(m);
  const bibliography = normalizeBibliography(m.bibliography);
  const hasBibliography = bibliographyPresent(bibliography);
  if (bibliography.doi) {
    await db`SELECT pg_advisory_xact_lock(hashtext(${'research-doi:' + bibliography.doi}))`;
    const [same] = await db<{ identity_key: string }[]>`SELECT identity_key FROM articles
      WHERE identity_key = ${identityKey} OR bibliography->>'doi' = ${bibliography.doi}
      ORDER BY discovered_at, id LIMIT 1`;
    identityKey = same?.identity_key ?? `doi:${bibliography.doi}`;
  }
  const discoveredAt = m.discoveredAt ?? new Date();
  const title = collapseWhitespace(m.title).slice(0, 1000) || m.url;

  const t = decideTimeline(m.publishedAt, discoveredAt, m.backfill);
  const newId = m.id ?? newArticleId();
  const hash = contentHash({ title, bodyText: m.bodyText, excerpt: m.excerpt });
  const [inserted] = await db<{ id: string }[]>`
    INSERT INTO articles (id, source_id, identity_key, url, title, author, language, published_at, published_at_claim,
      discovered_at, source_updated_at, timeline_at, backfill, backfill_reason, revision, content_hash, excerpt,
      body_text, body_html, body_status, media, x_post, raw, bibliography)
    VALUES (${newId}, ${m.sourceId}, ${identityKey}, ${m.url}, ${title}, ${m.author ?? null}, ${m.language ?? null},
      ${t.publishedAt}, ${m.publishedAt ?? null}, ${discoveredAt}, ${m.sourceUpdatedAt ?? null}, ${t.timelineAt},
      ${t.backfill}, ${t.backfillReason}, 1, ${hash}, ${m.excerpt ?? null}, ${m.bodyText ?? null}, ${m.bodyHtml ?? null},
      ${m.bodyStatus ?? (m.bodyText ? "ok" : "pending")}, ${db.json((m.media ?? []) as never)},
      ${m.xPost ? db.json(m.xPost as never) : null}, ${m.raw === undefined ? null : db.json(m.raw as never)}, ${hasBibliography ? db.json(bibliography as never) : null})
    ON CONFLICT (identity_key) DO NOTHING RETURNING id`;
  if (inserted) {
    await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${newId}, 1, ${hash}, ${title}, ${m.bodyText ?? null})`;
    await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at, source_url)
             VALUES (${newId}, ${m.sourceId}, ${m.via}, ${discoveredAt}, ${m.url}) ON CONFLICT DO NOTHING`;
    return { articleId: newId, created: true, revised: false, backfill: t.backfill };
  }

  const [existing] = await db<{ id: string; source_id: string; revision: number; content_hash: string | null; backfill: boolean; title: string; body_text: string | null; excerpt: string | null; published_at:Date|null; raw:Record<string,unknown>|null }[]>`
    SELECT id, source_id, revision, content_hash, backfill, title, body_text, excerpt, published_at, raw FROM articles WHERE identity_key = ${identityKey} FOR UPDATE`;
  await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at, source_url)
           VALUES (${existing!.id}, ${m.sourceId}, ${m.via}, ${discoveredAt}, ${m.url}) ON CONFLICT (article_id, source_id, via) DO UPDATE SET source_url = coalesce(article_discoveries.source_url, EXCLUDED.source_url)`;
  if (hasBibliography) await db`UPDATE articles SET bibliography = ${db.json(bibliography as never)}, research_enriched_at = NULL
    WHERE id = ${existing!.id} AND bibliography IS DISTINCT FROM ${db.json(bibliography as never)}`;
  const unchanged: MaterialResult = { articleId: existing!.id, created: false, revised: false, backfill: existing!.backfill };
  // Another source listing the same material (an aggregator, a translated mirror, a hot signal) is a
  // discovery only: its title and summary are its own rendering, and taking them made the article flip
  // between the two sources' versions on every fetch. Only the article's own source revises it.
  if (existing!.source_id !== m.sourceId) return unchanged;
  const rawRecord = m.raw && typeof m.raw === "object" ? m.raw as Record<string, unknown> : null;
  const sourceTime = storedSourcePublicationTime(rawRecord?.publicationTime, t.publishedAt);
  const existingTime = storedSourcePublicationTime(existing!.raw?.publicationTime, existing!.published_at);
  if (sourceTime && !(existingTime?.precision === "time" && sourceTime.precision === "day")) await db`UPDATE articles SET raw = jsonb_set(
    CASE WHEN jsonb_typeof(raw) = 'object' THEN raw ELSE '{}'::jsonb END,
    '{publicationTime}', ${db.json(sourceTime as never)})
    WHERE id = ${existing!.id} AND published_at = ${t.publishedAt}
      AND raw->'publicationTime' IS DISTINCT FROM ${db.json(sourceTime as never)}`;
  // What the row will hold after this report: a listing without body keeps the stored (extracted) body.
  const bodyText = m.bodyText ?? existing!.body_text;
  const excerpt = m.excerpt ?? existing!.excerpt;
  const next = contentHash({ title, bodyText, excerpt });
  if (existing!.content_hash === next) return unchanged;
  if (existing!.content_hash === null) {
    // Imported history carries no hash of this form (its collectors normalised differently): the
    // first report here records the baseline instead of a revision, so an import does not send
    // every article a source still lists back to paid analysis. The baseline joins the history, so
    // a later return to it is recognised as a version seen before.
    await db`UPDATE articles SET content_hash = ${next}, excerpt = coalesce(excerpt, ${m.excerpt ?? null}) WHERE id = ${existing!.id}`;
    await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${existing!.id}, ${existing!.revision}, ${next}, ${title}, ${bodyText}) ON CONFLICT DO NOTHING`;
    return unchanged;
  }
  // A version this article already had is no new material (listings that alternate between two
  // renderings, pages that rotate promotions): the current revision was analysed and published once
  // already. Any earlier version counts, however long ago: a rotation with many variants would
  // otherwise start over, and a real edit reverted later is rare and loses nothing.
  const [seen] = await db`SELECT 1 FROM article_revisions WHERE article_id = ${existing!.id} AND content_hash = ${next} LIMIT 1`;
  if (seen) return unchanged;
  // Nor is the stored version with other characters lost in transit, or with them restored.
  if (sameBarringLoss(existing!.title, title) && sameBarringLoss(existing!.body_text, bodyText) && sameBarringLoss(existing!.excerpt, excerpt)) return unchanged;

  const [row] = await db<{ revision: number }[]>`
    UPDATE articles SET
      title = ${title}, author = coalesce(${m.author ?? null}, author), language = coalesce(${m.language ?? null}, language),
      source_updated_at = ${m.sourceUpdatedAt ?? null}, excerpt = coalesce(${m.excerpt ?? null}, excerpt),
      body_text = coalesce(${m.bodyText ?? null}, body_text), body_html = coalesce(${m.bodyHtml ?? null}, body_html),
      body_status = CASE WHEN ${m.bodyText ?? null}::text IS NULL THEN body_status ELSE ${m.bodyStatus ?? "ok"} END,
      media = CASE WHEN ${m.media ? db.json(m.media as never) : null}::jsonb IS NULL THEN media ELSE ${m.media ? db.json(m.media as never) : null}::jsonb END,
      x_post = coalesce(${m.xPost ? db.json(m.xPost as never) : null}, x_post),
      revision = revision + 1, content_hash = ${next}, processing_state = 'new', updated_at = now(),
      research_abstract = NULL, research_source_url = NULL, research_enriched_at = NULL
    WHERE id = ${existing!.id}
    RETURNING revision`;
  await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
           VALUES (${existing!.id}, ${row!.revision}, ${next}, ${title}, ${bodyText})`;
  return { articleId: existing!.id, created: false, revised: true, backfill: existing!.backfill };
}
