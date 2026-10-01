// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
import type { CategoryKey } from '@aihot/contracts/taxonomy';
import { BASIS_LABELS, DOCUMENT_TYPES, type ResearchProfile } from '@aihot/contracts/research';
import { sql } from '../db.ts';
import { hasItemPage } from './rules.ts';

export async function loadItemShare(id: string) {
  const [row] = await sql<{
    id: string; title: string; summary: string | null; category: CategoryKey | null; selected: boolean;
    score: number | null; timeline_at: Date; source_name: string; source_mode: string; visibility: string; research: ResearchProfile | null;
  }[]>`SELECT p.article_id AS id, p.title, p.summary, p.category, p.selected, p.score, p.timeline_at, p.research,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${id}`;
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return null;
  const summary = row.research && row.research.status !== 'ready'
    ? `${BASIS_LABELS[row.research.basis]}，研究方法、结果与证据阶段待确认。` : row.summary;
  const researchKicker = row.research ? DOCUMENT_TYPES.find(v => v.key === row.research!.documentType)?.label || '研究资料' : null;
  return { id: row.id, title: row.title, summary, researchKicker, category: row.category, selected: row.selected,
    score: row.score === null ? null : Math.round(Number(row.score)), timelineAt: row.timeline_at.toISOString(),
    source: { name: row.source_name } };
}
