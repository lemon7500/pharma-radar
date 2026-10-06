// Publishing: derive the public projection of one article from its material, the latest judgement,
// manual overrides and grouping, then record selected-set changes in the sync ledger.
// Rebuilding only re-reads stored results; it never calls a model.
import { INDEX_CONTENT_SUMMARY } from "@aihot/contracts/site";
import { preliminaryAdmission, preliminaryResearch } from "./preliminary.ts";
import { SITE } from "@aihot/industry/site";
import { toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { config } from "../config.ts";
import { one, sql, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { itemUrl } from "./links.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { normalizeBibliography, supportedStoredResearch } from "../research/profile.ts";
import { scientificText } from "../research/material.ts";
import { editorialResearchMaterial, effectiveResearchMaterial, withResearchMaterialSources } from "../research/editorial-material.ts";
import type { Bibliography, ResearchProfile } from "@aihot/contracts/research";
import {
  bodyModeOf, channelOf, displayTags, isIndexable, isPoolEligible, isSelectable, mayRedistribute, type SourceFacts,
} from "./rules.ts";

interface ArticleRow {
  processing_state: string;
  canonical_article_id: string | null;
  revision: number;
  bibliography: Bibliography | null;
  research_profile: ResearchProfile | null;
  research_support: Record<string,string> | null;
  research_revision: number | null;
  research_material_kind: ResearchProfile["materialKind"];
  id: string;
  source_id: string;
  url: string;
  title: string;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  excerpt: string | null;
  x_post: unknown;
  grouped_at: Date | null;
}

interface AnalysisRow {
  id: number;
  relevance: string | null;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  index_only: boolean;
  first_public_at: Date | null;
  first_public_tracking: boolean;
  research: ResearchProfile | null;
  article_id: string;
  revision: number;
  visibility: string;
  eligible: boolean;
  selected: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  visible_after: Date | null;
  indexable: boolean;
  seo_indexed_at: Date | null;
  seo_excluded_at: Date | null;
}

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

export interface PublishOptions {
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  selected: boolean;
  visibility: string;
  ledger: "upsert" | "remove" | null;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export function v1Payload(p: {
  articleId: string; title: string; originalTitle: string | null; summary: string | null; sourceName: string; url: string;
  publishedAt: Date | null; discoveredAt: Date; category: string | null; score: number | null; selected: boolean; reason: string | null;
}): V1ItemPayload {
  const aihot = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { aihot, original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: aihot },
  };
}

/** Allocates the next ledger sequence under a transaction lock so sequence order equals commit order. */
async function appendLedger(tx: Tx, articleId: string, op: "upsert" | "remove", payload: V1ItemPayload | null, visibleAt: Date, now: Date): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))`;
  const { next } = one(await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM selected_ledger`);
  await tx`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
           VALUES (${next}, ${articleId}, ${op}, ${now}, ${visibleAt}, ${payload ? tx.json(payload as never) : null})`;
  return next;
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin((tx) => publishArticleTx(tx, articleId, options));
}

export async function publishArticleTx(tx: Tx, articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  const [article] = await tx<ArticleRow[]>`
    SELECT id, processing_state, revision, bibliography, research_profile, research_support, research_revision, research_material_kind, canonical_article_id, source_id, url, title, language, published_at, discovered_at, timeline_at, backfill, body_status,
           coalesce(research_abstract,body_text) AS body_text, excerpt, x_post, grouped_at
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  // Reports take this lock exclusively while reading candidates. Hold it through commit so a
  // release stamped before their cutoff cannot commit after their candidate snapshot.
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
  const now = options.now ?? new Date(); // sample after both locks, which may span a report cutoff
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext, syndicate_fulltext, config FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const [analysis] = await tx<AnalysisRow[]>`
    SELECT id, relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected
    FROM analyses WHERE article_id = ${articleId} AND input_revision = ${article.revision} ORDER BY id DESC LIMIT 1`;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;

  const f = override?.fields ?? {};
  const editorial = editorialResearchMaterial(f.researchMaterial);
  const material = effectiveResearchMaterial({ title: article.title, bodyText: article.body_text, excerpt: article.excerpt,
    bibliography: normalizeBibliography(f.researchBibliography ?? article.bibliography), materialKind: article.research_material_kind ?? undefined }, editorial);
  let research = withResearchMaterialSources(supportedStoredResearch(
    f.research ?? (article.research_revision === article.revision ? article.research_profile : null),
    f.research ? f.researchSupport : article.research_support,
    material,
  ), editorial);
  const indexOnly = !analysis && f.relevance !== "pass" && f.relevance !== "block" && preliminaryAdmission({ source, article, material, now });
  if (indexOnly) research = preliminaryResearch(material);
  const isChineseTitle = article.language === "zh" || /[一-鿿]/.test(article.title);
  // An X post carries its Chinese in the summary and translation; without a Chinese title its own
  // text is the title, where an article would still be a half-finished card.
  const zhTitle = analysis?.title_zh?.trim() ? analysis.title_zh : null;
  const title = indexOnly ? collapseWhitespace(scientificText(article.title)) : pickString(f.title, zhTitle ?? (isChineseTitle || article.x_post ? collapseWhitespace(article.title) : null));
  const structuredSummary = research.status === "ready" ? [research.claims.results ?? research.claims.question, research.claims.limitations].filter(Boolean).join(" ") : null;
  const academic = !!(research.bibliography.doi || research.bibliography.journal || article.research_profile);
  const scopeSummary = research.status === "insufficient" ? "当前材料不足，保留文献索引与原文入口，研究设计和结果待核对。" : "研究导读尚未完整，保留已核对的文献信息与原文入口。";
  const summary = indexOnly ? INDEX_CONTENT_SUMMARY : pickString(f.summary, structuredSummary || (academic ? scopeSummary : analysis?.summary_zh) || null);
  const category = indexOnly ? null : pickString(f.category, analysis?.category ?? null);
  const candidateTags = Array.isArray(f.tags) ? (f.tags as string[]) : [...new Set([...(analysis?.tags ?? []), ...(analysis?.subjects ?? []).map((s) => `entity:${s}`)])];
  const tags = indexOnly ? [] : candidateTags.filter(tag => tag !== "临床试验" || research.evidenceStages.includes("clinical"));
  const score = indexOnly ? null : typeof f.score === "number" ? f.score : analysis?.score ?? null;
  const relevance = typeof f.relevance === "string" ? (f.relevance as string) : analysis?.relevance ?? null;
  const judgedSelected = typeof f.selected === "boolean" ? (f.selected as boolean) : analysis?.selected ?? null;
  // Material from an isolated source reaches no public surface at all: not even a detail page.
  const visibility = source.participation_mode === "isolated" ? "withdrawn" : (override?.visibility ?? "public");

  const eligible = !article.canonical_article_id && (indexOnly || isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary }));
  const selected = !indexOnly && isSelectable(eligible, judgedSelected, source.tier) && (!academic || research.status === "ready") && (research.bibliography.isPreprint !== true || f.selected === true);
  const reason = selected ? pickString(f.reason, analysis?.reason_zh ?? null) : null;
  const hasXPost = !!article.x_post;
  const channel = channelOf(source.kind, hasXPost);
  const bodyMode = indexOnly ? "summary" : bodyModeOf(source, article.body_status, !!article.body_text && article.body_text.length > 0);
  const syndicate = mayRedistribute(source, bodyMode);
  const originalTitle = isChineseTitle && title === collapseWhitespace(article.title) ? null : collapseWhitespace(scientificText(article.title));

  // Release gate: first time the item met the selected conditions, released after grouping or 180 s.
  let selectedReadyAt = previous?.selected_ready_at ?? null;
  let visibleAfter = previous?.visible_after ?? null;
  if (selected && !selectedReadyAt) {
    selectedReadyAt = options.releasedAt ?? now;
    visibleAfter = options.releasedAt
      ? options.releasedAt
      : article.grouped_at && article.grouped_at <= now
        ? now
        : new Date(now.getTime() + config.selectedVisibleAfterSeconds * 1000);
  } else if (selected && visibleAfter && visibleAfter > now && article.grouped_at && article.grouped_at <= now) {
    const earliest = new Date(Math.max(selectedReadyAt!.getTime(), article.grouped_at.getTime()));
    if (earliest < visibleAfter) {
      // A grouping decision can predate publication. Reports wait for this release to commit.
      visibleAfter = new Date(Math.max(earliest.getTime(), now.getTime()));
      // The not-yet-visible sync entry follows the same release time as the site.
      await tx`UPDATE selected_ledger SET visible_at = ${visibleAfter} WHERE article_id = ${articleId} AND visible_at > ${visibleAfter}`;
    }
  }

  const indexable = !indexOnly && isIndexable({
    visibility, hasSummary: !!summary, selected, seoIndexedAt: previous?.seo_indexed_at ?? null, seoExcludedAt: previous?.seo_excluded_at ?? null,
  });
  const searchText = collapseWhitespace(
    [title, originalTitle, summary, source.name, research.bibliography.doi, research.bibliography.journal, ...research.bibliography.authors,
      ...Object.values(research.claims), ...displayTags(tags), ...(analysis?.subjects ?? [])].filter(Boolean).join(" "),
  ).toLowerCase();

  // A selected item sits at its reading group's anchor: the earliest public pool member of its fact.
  let sortAt: Date = article.timeline_at;
  if (selected && membership?.fact_id) {
    const [anchor] = await tx<{ t: Date | null }[]>`
      SELECT min(timeline_at) AS t FROM publications
      WHERE fact_id = ${membership.fact_id} AND eligible AND visibility = 'public' AND article_id <> ${articleId}`;
    if (anchor?.t && anchor.t < sortAt) sortAt = anchor.t;
  }

  const next = {
    visibility, eligible, selected, title: title ?? collapseWhitespace(article.title), original_title: originalTitle, summary, reason,
    category, tags, score: round1(score), body_mode: bodyMode, story_id: membership?.story_id ?? null, fact_id: membership?.fact_id ?? null,
    indexable, research, index_only: indexOnly,
  };
  const changed =
    !previous ||
    stableJson({ ...next, tags: [...next.tags].sort() }) !==
      stableJson({
        visibility: previous.visibility, eligible: previous.eligible, selected: previous.selected, title: previous.title,
        original_title: previous.original_title, summary: previous.summary, reason: previous.reason, category: previous.category,
        tags: [...previous.tags].sort(), score: previous.score === null ? null : Number(previous.score), body_mode: previous.body_mode,
        story_id: previous.story_id, fact_id: previous.fact_id, indexable: previous.indexable, research: previous.research, index_only: previous.index_only,
      });
  const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;

  // Never manufacture a first-public time for legacy already-public rows.
  const tracking = previous?.first_public_tracking ?? true;
  const visibleNow = eligible && visibility === "public" && (!selected || !!visibleAfter && visibleAfter <= now);
  const legacyAlreadyPublic = previous?.eligible && previous.visibility === "public";
  const knownRelease = tracking && previous?.eligible && previous.visibility === "public" && previous.selected && previous.visible_after && previous.visible_after <= now ? previous.visible_after : now;
  const firstPublicAt = previous?.first_public_at ?? (visibleNow && (tracking || !legacyAlreadyPublic) ? knownRelease : null);
  const firstPublicTracking = tracking || !legacyAlreadyPublic && eligible && visibility === "public";

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, title, original_title, summary,
      reason, category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id, search_text, sort_at, research, index_only, first_public_at, first_public_tracking, updated_at)
    VALUES (${articleId}, ${analysis?.id ?? null}, ${revision}, ${visibility}, ${eligible}, ${selected}, ${next.title},
      ${originalTitle}, ${summary}, ${reason}, ${category}, ${tags}, ${next.score}, ${source.id}, ${channel}, ${source.first_party},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${visibleAfter}, ${bodyMode}, ${syndicate}, ${indexable}, ${next.story_id}, ${next.fact_id}, ${searchText}, ${sortAt}, ${tx.json(research as never)}, ${indexOnly}, ${firstPublicAt}, ${firstPublicTracking}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, reason = EXCLUDED.reason, category = EXCLUDED.category, tags = EXCLUDED.tags,
      score = EXCLUDED.score, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode, syndicate = EXCLUDED.syndicate,
      indexable = EXCLUDED.indexable, story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id,
      search_text = EXCLUDED.search_text, sort_at = EXCLUDED.sort_at, research = EXCLUDED.research, index_only = EXCLUDED.index_only, first_public_at = EXCLUDED.first_public_at, first_public_tracking = EXCLUDED.first_public_tracking, updated_at = now()
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.eligible,
        publications.selected, publications.title, publications.original_title, publications.summary,
        publications.reason, publications.category, publications.tags, publications.score,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.visible_after, publications.body_mode, publications.syndicate,
        publications.indexable, publications.story_id, publications.fact_id, publications.search_text,
        publications.sort_at, publications.research, publications.index_only, publications.first_public_at, publications.first_public_tracking)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.tags, EXCLUDED.score,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.visible_after, EXCLUDED.body_mode, EXCLUDED.syndicate,
        EXCLUDED.indexable, EXCLUDED.story_id, EXCLUDED.fact_id, EXCLUDED.search_text,
        EXCLUDED.sort_at, EXCLUDED.research, EXCLUDED.index_only, EXCLUDED.first_public_at, EXCLUDED.first_public_tracking)`;

  // The pool search row follows eligibility; its body part only covers full text the site may show.
  if (eligible) {
    const body = bodyMode === "full" ? (article.body_text ?? "").slice(0, 12000).toLowerCase() : "";
    await tx`INSERT INTO pool_search (article_id, direct, body) VALUES (${articleId}, ${searchText}, ${body})
             ON CONFLICT (article_id) DO UPDATE SET direct = EXCLUDED.direct, body = EXCLUDED.body
             WHERE pool_search.direct IS DISTINCT FROM EXCLUDED.direct OR pool_search.body IS DISTINCT FROM EXCLUDED.body`;
  } else {
    await tx`DELETE FROM pool_search WHERE article_id = ${articleId}`;
  }

  // Content-group push: once, for an item that arrives live and becomes selected (never for imports,
  // backfill or stale-on-discovery material); it runs after the release gate opens.
  if (selected && !previous?.selected_ready_at && !options.releasedAt && !article.backfill && visibility === "public") {
    const at = visibleAfter && visibleAfter > now ? visibleAfter : now;
    await enqueue(QUEUES.notifySelected, { articleId }, { singletonKey: `selected:${articleId}`, startAfter: new Date(at.getTime() + 5_000) }, tx);
    // Its images are fetched and resized now, before the release gate lets readers in.
    await enqueue(QUEUES.prepareMedia, { articleId }, { singletonKey: `media:${articleId}` }, tx);
  }

  // Selected sync ledger: the public selected set is (selected AND visibility = public).
  const inSet = selected && visibility === "public";
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`SELECT in_set, payload_hash FROM selected_state WHERE article_id = ${articleId}`;
  let ledger: "upsert" | "remove" | null = null;
  if (inSet) {
    const payload = v1Payload({
      articleId, title: next.title, originalTitle, summary, sourceName: source.name, url: article.url,
      publishedAt: article.published_at, discoveredAt: article.discovered_at, category, score: next.score, selected: true, reason,
    });
    const payloadHash = sha256(stableJson(payload));
    if (!state || !state.in_set || state.payload_hash !== payloadHash) {
      const visibleAt = visibleAfter && visibleAfter > now ? visibleAfter : now;
      const seq = await appendLedger(tx, articleId, "upsert", payload, visibleAt, now);
      await tx`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq) VALUES (${articleId}, true, ${payloadHash}, ${seq})
               ON CONFLICT (article_id) DO UPDATE SET in_set = true, payload_hash = EXCLUDED.payload_hash, last_seq = EXCLUDED.last_seq`;
      ledger = "upsert";
    }
  } else if (state?.in_set) {
    const seq = await appendLedger(tx, articleId, "remove", null, now, now);
    await tx`UPDATE selected_state SET in_set = false, payload_hash = NULL, last_seq = ${seq} WHERE article_id = ${articleId}`;
    ledger = "remove";
  }

  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" || !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  return { articleId, changed, selected, visibility, ledger, reduced };
}

/** Record a tracked automatic release after its gate opened. Legacy timestamps
 * stay unknown, and a withdrawal before release does not become a public sample. */
export async function observePublicReleaseTimes(): Promise<number> {
  const rows = await sql`
    UPDATE publications p SET first_public_at = p.visible_after
    FROM articles a, sources s
    WHERE p.article_id = a.id AND p.source_id = s.id AND a.canonical_article_id IS NULL
      AND s.participation_mode = 'editorial' AND p.first_public_tracking
      AND p.first_public_at IS NULL AND p.eligible AND p.visibility = 'public'
      AND p.selected AND p.visible_after <= now()
    RETURNING p.article_id`;
  return rows.length;
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback.
 */
export async function republishSource(sourceId: string, onProgress?: (done: number, total: number) => Promise<void>): Promise<{ total: number; changed: number; reduced: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) {
      // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      const r = await publishArticle(article_id);
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
    }
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  return { total, changed, reduced };
}
