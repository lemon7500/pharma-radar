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
  const explicitPharmacy = /\b(?:pharmac\w*|drug (?:discovery|design|development|delivery)|anti[- ]?(?:cancer|tumou?r))\b|药物研发|药理/i.test(text);
  if (nonmedicalUse && !explicitPharmacy) return false;
  if (outsidePharmacy(text)) return false;
  // Clinical trials and traditional medicine also include non-drug treatments.
  // Early indexes require a pharmaceutical subject, rather than therapy alone.
  const pharmacySubject = /\b(?:drugs?|pharmac\w*|pharmaceutical\w*|ethnopharmac\w*|medicinal chemistry|drug[- ]like|formulations?|vaccin\w*|biologics?)\b|药物|药理|药学|药代|制剂/i;
  const naturalIntervention = /\b(?:Chinese herbal medicine|herbal (?:medicine|formulas?|formulations?|extracts?|preparations?)|plant extracts?|natural products?|(?:active|bioactive|natural) (?:compounds?|constituents?|ingredients?)|small molecules?|decoctions?)\b|中药|草药|方剂|汤剂|天然产物|活性(?:成分|化合物)|小分子|植物提取物/i;
  const pharmacologicalUse = /\b(?:therap\w*|treat(?:ment|ed|ing)|anti[- ]?(?:cancer|tumou?r|inflamm\w*|viral|bacterial)|pharmac\w*|receptors?|agonists?|antagonists?|bioactiv\w*)\b|治疗|药效|药理|抗(?:肿瘤|癌|炎|病毒|菌)|受体/i;
  const relevant = (value: string) => {
    const subject = value.replace(/\b(?:non[- ](?:pharmac\w*|drugs?)|drug[- ]free)\b|非(?:药物|药理)|无药物/gi, "");
    return pharmacySubject.test(subject) || naturalIntervention.test(subject) && pharmacologicalUse.test(subject);
  };
  const backgroundOnly = /\b(?:no|not|without|exclude\w*|prior|previous|background|concomitant|rescue|history|non[- ](?:drug|pharmac\w*))\b|无药|非药物|排除|既往|背景|停用|禁用/i;
  if (relevant(article.title) && !backgroundOnly.test(article.title)) return true;
  const nonDrugTitle = /\b(?:massage|tui[- ]?na|acupunctur\w*|electroacupunctur\w*|exercise|positional release|physiotherap\w*|rehabilitat\w*|psychotherap\w*|manual therap\w*)\b|针灸|推拿|按摩|运动疗法|康复/i.test(article.title);
  const studyIntervention = /\b(?:administer\w*|received|compar\w*|randomi[sz]\w*|intervention|combined with|oral|dos(?:e|ing))\b|给药|服用|干预|对照|联合|口服|剂量/i;
  return text.slice(article.title.length + 1).split(/[.!?。；;]/).some(sentence =>
    relevant(sentence) && !backgroundOnly.test(sentence) && (!nonDrugTitle || studyIntervention.test(sentence)));
}

export function preliminaryResearch(material: ResearchMaterial): ResearchProfile {
  const r = baselineResearch(material);
  // Source metadata is retained; all inferential facets and research claims wait
  // for the existing evidence-supported processing and publishing path.
  return { ...r, areas: [], foci: [], evidenceStages: [], clinicalPhase: null, status: "pending" };
}
