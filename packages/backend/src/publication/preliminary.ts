// Free, conservative admission for a bibliographic index. This does not judge a
// paper's results, assign evidence stages, or select it for recommendation.
import type { Bibliography, ResearchProfile } from "@aihot/contracts/research";
import { baselineResearch, materialBasis, normalizeBibliography, outsidePharmacy, type ResearchMaterial } from "../research/profile.ts";

export interface PreliminaryInput {
  source: { kind: string; participation_mode: string; config?: Record<string, unknown> };
  article: { url: string; title: string; published_at: Date | null; bibliography: Bibliography | null; processing_state: string; canonical_article_id: string | null };
  material: ResearchMaterial;
  now: Date;
}

export function preliminaryAdmission(input: PreliminaryInput): boolean {
  const { source, article, material, now } = input;
  if (source.participation_mode !== "editorial" || source.config?.preliminaryIndex !== true || article.canonical_article_id || article.processing_state === "blocked") return false;
  const b = normalizeBibliography(article.bibliography);
  if (!article.title.trim() || !b.journal || !b.publishedDate || !(b.doi || b.pmid) || !article.published_at || article.published_at > now) return false;
  if (!article.published_at.toISOString().startsWith(b.publishedDate)) return false;
  let url: URL;
  try { url = new URL(article.url); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  // These adapters read identifiers from the article's own source metadata.
  // A DOI merely mentioned in body text cannot pass this gate.
  let ownRecord = false;
  if (source.kind === "json_list" && url.hostname === "europepmc.org") {
    const match = /^\/article\/(MED|PPR|PMC)\/([\w.-]+)\/?$/.exec(url.pathname);
    ownRecord = !!match && (match[1] !== "MED" || match[2] === b.pmid);
    try { ownRecord = ownRecord && new URL(String(source.config?.url)).hostname === "www.ebi.ac.uk"; } catch { return false; }
  } else if (source.kind === "rss" && url.hostname === "www.nature.com" && /^\/articles\/[\w.-]+\/?$/.test(url.pathname)) {
    const slug = url.pathname.split("/")[2];
    ownRecord = b.doi === `10.1038/${slug}`.toLowerCase();
    try { ownRecord = ownRecord && new URL(String(source.config?.feedUrl)).hostname === "www.nature.com"; } catch { return false; }
  }
  if (!ownRecord) return false;
  const text = `${article.title}\n${materialBasis(material) === "insufficient" ? "" : material.bodyText || material.excerpt || ""}`;
  const nonmedicalUse = /\b(?:crop|weed|herbicid\w*|insecticid\w*|pesticid\w*|agrochem\w*|agricultur\w*|food|ecolog\w*|plant (?:disease|pathogen|toxicity|treatment)|plants?\s+(?:treated|treatment)|treatment\s+of\s+plants?)\b|农用|农业|农药|除草|植物病害|食品|生态/i.test(text);
  const explicitPharmacy = /\b(?:pharmac\w*|patients?|drug (?:discovery|design|development|delivery)|clinical (?:trial|study)|anti[- ]?(?:cancer|tumou?r))\b|药物研发|药理|患者|临床试验/i.test(text);
  if (nonmedicalUse && !explicitPharmacy) return false;
  if (outsidePharmacy(text)) return false;
  // Explicit pharmacological or therapeutic relevance is required. General AI,
  // plant science and broad health news stay private until editorial processing.
  return /\b(?:drugs?|pharmac\w*|medicinal|therap\w*|treat(?:ment|ed|ing)|drug[- ]like|anti[- ]?(?:cancer|tumou?r|inflamm\w*|viral|bacterial)|ethnopharmac\w*|traditional Chinese medicine|Chinese herbal medicine)\b|药物|药理|药学|中药|治疗|制剂|药代/i.test(text);
}

export function preliminaryResearch(material: ResearchMaterial): ResearchProfile {
  const r = baselineResearch(material);
  // Source metadata is retained; all inferential facets and research claims wait
  // for the existing evidence-supported processing and publishing path.
  return { ...r, areas: [], foci: [], evidenceStages: [], clinicalPhase: null, status: "pending" };
}
