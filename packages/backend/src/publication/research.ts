import type { FeedItemSummary } from "@aihot/contracts/site";
import { RESEARCH_FOCI, RESEARCH_AREAS, type ResearchArea, type ResearchFocus } from "@aihot/contracts/research";
import { sql } from "../db.ts";
import { listedCondition } from "./items.ts";
import { loadTimeline } from "./timeline.ts";
import { loadPool } from "./pool.ts";
import { publicationOrderAt } from "./time.ts";
import { loadHotStrip } from "../events/hot-read.ts";
import { listTopics, loadTopic, topicMatchTags, type TopicSummary } from "./topics.ts";
export async function researchOverview() {
  const now = new Date();
  const [timeline, library, selection, hot, counts] = await Promise.all([
    loadTimeline({ channel: "all", category: null, tag: null, limit: 12 }),
    loadPool({ channel: "all", category: null, tag: null, page: 1, timeBasis:"publication" }),
    loadPool({ channel: "all", category: null, tag: null, page: 1, timeBasis:"publication", selectedOnly:true }),
    loadHotStrip(),
    sql<{ total: number; latest: Date | null; foci: Record<string, number>; areas: Record<string, number> }[]>`
      SELECT count(*)::int AS total, max(p.updated_at) AS latest,
        jsonb_build_object('tcm-natural-products', count(*) FILTER (WHERE p.research @> '{"foci":["tcm-natural-products"]}'::jsonb),
          'ai-pharma', count(*) FILTER (WHERE p.research @> '{"foci":["ai-pharma"]}'::jsonb)) AS foci,
        jsonb_build_object('discovery', count(*) FILTER (WHERE p.research @> '{"areas":["discovery"]}'::jsonb),
          'mechanisms', count(*) FILTER (WHERE p.research @> '{"areas":["mechanisms"]}'::jsonb),
          'formulation-pk', count(*) FILTER (WHERE p.research @> '{"areas":["formulation-pk"]}'::jsonb),
          'translation', count(*) FILTER (WHERE p.research @> '{"areas":["translation"]}'::jsonb)) AS areas
      FROM publications p WHERE ${listedCondition(now)} AND p.eligible`,
  ]);
  const selected = selection.items.slice(0, 6);
  const selectedIds = new Set(selected.map(i => i.id));
  return {
    hot, selected, latest: library.items.filter(i => !selectedIds.has(i.id)).slice(0, 6) as FeedItemSummary[], total: counts[0]!.total,
    updatedAt: counts[0]!.latest?.toISOString() ?? null, refreshAt: timeline.refreshAt,
    foci: RESEARCH_FOCI.map(f => ({ ...f, total: Number(counts[0]!.foci[f.key] || 0) })),
    areas: RESEARCH_AREAS.map(a => ({ ...a, total: Number(counts[0]!.areas[a.key] || 0) })),
  };
}

/** Reader topics include all eligible records. The original selected-topic/RSS contracts stay intact. */
export async function researchTopics(now = new Date()): Promise<TopicSummary[]> {
  const [topics, items] = await Promise.all([
    listTopics(),
    sql<{ tags: string[]; foci: string[]; published_at: Date | null }[]>`
      SELECT p.tags, COALESCE(p.research->'foci','[]'::jsonb) AS foci, (${publicationOrderAt(now)}) AS published_at
      FROM publications p WHERE ${listedCondition(now)} AND p.eligible`,
  ]);
  return topics.map(t => {
    const focus = RESEARCH_FOCI.find(f => f.key === t.slug);
    const tags = new Set(topicMatchTags(t));
    const matches = items.filter(i => focus ? i.foci.includes(focus.key) : i.tags.some(tag => tags.has(tag)));
    const recent = matches.filter(i => i.published_at && i.published_at.getTime() > now.getTime() - 30 * 86400_000).length;
    const latestAt = matches.reduce<string | null>((v,i) => i.published_at && (!v || i.published_at.toISOString() > v) ? i.published_at.toISOString() : v, null);
    return { slug:t.slug, name:t.name, group:t.grp, definition:t.definition, total:matches.length, recent, latestAt, indexable:matches.length >= 50 || (matches.length >= 20 && recent > 0) };
  });
}

export async function researchTopicPage(slug: string, page: number, area?: ResearchArea, dates: { from?: string; to?: string } = {}) {
  const row = await loadTopic(slug);
  if (!row || !Number.isInteger(page) || page < 1 || page > 50) return null;
  const focus = RESEARCH_FOCI.find(f => f.key === slug)?.key as ResearchFocus | undefined;
  const [summaries, pool] = await Promise.all([
    researchTopics(),
    loadPool({ channel:"all", category:null, tag:null, page, timeBasis:"publication", ...dates,
      ...(focus ? { focus:[focus] } : { topic:slug, topicTags:topicMatchTags(row) }),
      ...(area ? { area:[area] } : {}),
    }),
  ]);
  if (page > pool.pageCount && page > 1) return null;
  const topic = summaries.find(t => t.slug === slug)!;
  const related = row.related.map(s => summaries.find(t => t.slug === s)).filter((v): v is TopicSummary => !!v).map(v => ({ slug:v.slug,name:v.name }));
  return { topic:{...topic,related}, items:pool.items, page:pool.page, pageCount:pool.pageCount, filteredTotal:pool.total, area:area ?? null };
}
