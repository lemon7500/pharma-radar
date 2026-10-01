import { RESEARCH_AREAS, RESEARCH_FOCI, DOCUMENT_TYPES, EVIDENCE_STAGES, SOURCE_ORIGINS, RESEARCH_CLAIMS } from "@aihot/industry/research";
export { RESEARCH_AREAS, RESEARCH_FOCI, DOCUMENT_TYPES, EVIDENCE_STAGES, SOURCE_ORIGINS, RESEARCH_CLAIMS };
export type ResearchArea = (typeof RESEARCH_AREAS)[number]["key"];
export type ResearchFocus = (typeof RESEARCH_FOCI)[number]["key"];
export type DocumentType = (typeof DOCUMENT_TYPES)[number]["key"];
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number]["key"];
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number]["key"];
export type ResearchClaim = (typeof RESEARCH_CLAIMS)[number]["key"];
export interface Bibliography {
  doi: string | null; pmid: string | null; authors: string[]; journal: string | null;
  publishedDate: string | null; publicationTypes: string[]; isPreprint: boolean | null;
}
export interface ResearchProfile {
  version: 1;
  bibliography: Bibliography;
  areas: ResearchArea[]; foci: ResearchFocus[]; documentType: DocumentType | null;
  evidenceStages: EvidenceStage[]; clinicalPhase: string | null; origin: SourceOrigin;
  basis: "fulltext" | "abstract" | "title" | "insufficient";
  status: "ready" | "pending" | "insufficient";
  claims: Record<ResearchClaim, string | null>;
}
export interface ResearchFilters {
  area?: ResearchArea[]; focus?: ResearchFocus[]; docType?: DocumentType[];
  evidence?: EvidenceStage[]; origin?: SourceOrigin[];
}
export const FACET_GROUPS = [
  { param: "area", label: "研究环节", values: RESEARCH_AREAS },
  { param: "focus", label: "重点专题", values: RESEARCH_FOCI },
  { param: "docType", label: "内容形式", values: DOCUMENT_TYPES },
  { param: "evidence", label: "证据阶段", values: EVIDENCE_STAGES },
  { param: "origin", label: "来源属性", values: SOURCE_ORIGINS },
] as const;
/** A shared allowlist for the website and its HTTP read layer. Comma lists use OR within a facet. */
export function parseResearchFilters(input: URLSearchParams): ResearchFilters {
  const result: Record<string, string[]> = {};
  for (const group of FACET_GROUPS) {
    const allowed = new Set<string>(group.values.map(v => v.key));
    const values = [...new Set(input.getAll(group.param).flatMap(v => v.split(",")).filter(v => allowed.has(v)))];
    if (values.length) result[group.param] = values;
  }
  return result as ResearchFilters;
}
export function researchFilterParams(filters: ResearchFilters): Record<string, string | null> {
  return Object.fromEntries(FACET_GROUPS.map(g => [g.param, filters[g.param]?.join(",") || null]));
}
export const BASIS_LABELS: Record<ResearchProfile["basis"], string> = {
  fulltext: "基于已获取原文", abstract: "基于原文摘要", title: "仅有标题", insufficient: "研究材料不足",
};
