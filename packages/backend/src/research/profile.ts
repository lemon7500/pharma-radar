import type { Bibliography, ResearchProfile, ResearchClaim } from "@aihot/contracts/research";
import { RESEARCH_AREAS, RESEARCH_FOCI, DOCUMENT_TYPES, EVIDENCE_STAGES, SOURCE_ORIGINS, RESEARCH_CLAIMS } from "@aihot/contracts/research";
import { collapseWhitespace } from "../lib/text.ts";
import { scientificText } from "./material.ts";

const string = (v: unknown, max = 400): string | null => typeof v === "string" && v.trim() ? collapseWhitespace(scientificText(v)).slice(0, max) : null;
const strings = (v: unknown, max = 50): string[] => Array.isArray(v) ? [...new Set(v.map(x => string(x, 200)).filter((x): x is string => !!x))].slice(0, max) : [];
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export function normalizeDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>"{}]+$/.test(doi) && doi.length <= 200 ? doi : null;
}
export function normalizeBibliography(value: unknown): Bibliography {
  const v = record(value);
  const date = string(v.publishedDate, 10);
  const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date);
  return {
    doi: normalizeDoi(v.doi), pmid: typeof v.pmid === "string" && /^\d{1,12}$/.test(v.pmid) ? v.pmid : null,
    authors: strings(v.authors), journal: string(v.journal, 300), publishedDate: validDate ? date : null,
    publicationTypes: strings(v.publicationTypes, 10), isPreprint: typeof v.isPreprint === "boolean" ? v.isPreprint : null,
  };
}
/** The source's own bibliographic record only; never read identifiers from references. */
export function europePmcBibliography(item: unknown): Bibliography {
  const v = record(item);
  const authors = record(v.authorList).author;
  const types = strings(record(v.pubTypeList).pubType, 10);
  return normalizeBibliography({
    doi: v.doi, pmid: v.pmid ?? (v.source === "MED" ? v.id : null),
    authors: Array.isArray(authors) ? authors.map(a => record(a).fullName || record(a).collectiveName) : string(v.authorString)?.split(/,\s*/) ?? [],
    journal: record(record(v.journalInfo).journal).title,
    publishedDate: v.firstPublicationDate,
    publicationTypes: types,
    isPreprint: /PPR/.test(String(v.source)) || types.some(t => /preprint/i.test(t)),
  });
}
export function bibliographyPresent(b: Bibliography): boolean { return !!(b.doi || b.pmid || b.journal || b.publishedDate || b.authors.length); }

export interface ResearchMaterial { title: string; bodyText?: string | null; excerpt?: string | null; bibliography?: Bibliography | null; fullText?: boolean; materialKind?: ResearchProfile["materialKind"]; }
export function materialBasis(material: ResearchMaterial): ResearchProfile["basis"] {
  const text = (material.bodyText || material.excerpt || "").trim();
  if (text.length < 100) return "title";
  // Reference-list extraction is common on journal landing pages. It cannot support a research note.
  const citations = (text.match(/\b10\.\d{4,9}\//g) || []).length;
  const referenceStart = /^(?:(?:references|bibliography)\b|参考文献)/i.test(text);
  const studyText = /\b(?:abstract|methods|we (?:investigat|exam|evaluat|found|show|report)|our (?:study|results)|results|conclusions|experimental approach)\b|摘要|研究方法|研究结果|结论/i.test(text);
  if (referenceStart || (citations >= 3 && !studyText)) return "insufficient";
  return material.fullText ? "fulltext" : "abstract";
}
const areaPatterns: Record<string, RegExp> = {
  discovery: /drug discover|drug design|screening|lead compound|target identification|药物发现|分子设计|筛选|靶点发现/i,
  mechanisms: /mechanis|signaling|pharmacolog|toxic|作用机制|药理|毒理/i,
  "formulation-pk": /pharmacokinetic|drug delivery|formulation|制剂|药代|递送/i,
  translation: /\bclinical (?:trial|stud|research)|randomi[sz]ed|translational research|临床试验|临床研究|转化研究/i,
};
const focusPatterns: Record<string, RegExp> = {
  "tcm-natural-products": /traditional Chinese medicine|Chinese herbal|herbal medicine|natural products?|ethnopharmacolog|phytochemic|中药|方剂|药用植物|天然产物/i,
  "ai-pharma": /artificial intelligence|machine learning|deep learning|neural network|AI[- ](?:driven|based)|AI.?药|人工智能|机器学习|深度学习/i,
};
const pharmacy = /drug|pharmac|therap|treat(?:ment|ed)|disease|cancer|anti[- ]?(?:tumou?r|inflamm|viral|bacterial)|arthritis|diabet|endometritis|药|治疗|疾病|肿瘤/i;
const agricultural = /agrochem|herbicid|crop|weed|insecticid|plant toxicity|food preserv|食品保鲜|除草|农药/i;
const aiTerms = /artificial intelligence|machine learning|deep learning|neural network|language model|transformer|AI[- ](?:driven|based)|人工智能|机器学习|深度学习|神经网络/i;
const prospectOnly = /\b(?:future|prospect|outlook|potential for|could|may|might|will|promise)\b|展望|未来|有望|可能|建议/i;
export function focusSupported(focus: string, quote: string, material: ResearchMaterial): boolean {
  const text = `${material.title}\n${material.bodyText || material.excerpt || ""}`;
  if (focus === "ai-pharma") return quote.split(/[.!?。；;]/).some(sentence => aiTerms.test(sentence) && !prospectOnly.test(sentence));
  const naturalCue = /traditional Chinese|herbal|natural product|phytochem|ethnopharmac|plant|extract|granules?|decoction|isolated from|中药|天然|植物|颗粒|提取|方剂/i.test(quote);
  return naturalCue && pharmacy.test(text) && !outsidePharmacy(text);
}
export function outsidePharmacy(text: string): boolean {
  return agricultural.test(text) && !/pharmac|human|patient|therap|disease|anti[- ]?(?:tumou?r|inflamm|viral|bacterial)|药理|人体|患者|疾病/i.test(text);
}
const isSecondary = (b: Bibliography) => b.publicationTypes.some(t => /^(?:News|Research Highlight|News and Views|News & Views)$/i.test(t));
export function baselineResearch(material: ResearchMaterial): ResearchProfile {
  const bibliography = normalizeBibliography(material.bibliography);
  const basis = materialBasis(material);
  const text = `${material.title}\n${basis === "insufficient" ? "" : material.bodyText || material.excerpt || ""}`;
  return {
    version: 1, bibliography,
    areas: RESEARCH_AREAS.filter(v => areaPatterns[v.key]!.test(material.title)).map(v => v.key),
    foci: RESEARCH_FOCI.filter(v => focusPatterns[v.key]!.test(text) && focusSupported(v.key, material.title, material)).map(v => v.key),
    documentType: bibliography.publicationTypes.some(t => /review/i.test(t)) ? "review"
      : bibliography.publicationTypes.some(t => /methods?-article|method|resource/i.test(t)) ? "methods-resources"
      : isSecondary(bibliography) ? "news-policy"
      : bibliography.publicationTypes.some(t => /^(?:Article|Research Article|Journal Article|Clinical Trial)$/i.test(t)) ? "original-research" : null,
    evidenceStages: [], clinicalPhase: null,
    origin: isSecondary(bibliography) ? "secondary"
      : (bibliography.doi || bibliography.pmid) && bibliography.journal ? "primary" : "unknown",
    basis, materialKind: basis === "title" ? "title" : basis === "insufficient" ? "unusable" : material.fullText ? "fulltext" : material.materialKind ?? (isSecondary(bibliography) ? "publisher-summary" : "paper-abstract"),
    status: basis === "title" || basis === "insufficient" ? "insufficient" : "pending",
    claims: Object.fromEntries(RESEARCH_CLAIMS.map(c => [c.key, null])) as Record<ResearchClaim, null>,
  };
}
const stagePatterns: Record<string, RegExp> = {
  computational: /\b(?:in silico|computational|molecular docking|machine learning|deep learning|neural network|language model|density functional|virtual screening|simulation|artificial intelligence)\b|计算模拟|分子对接|虚拟筛选|机器学习|人工智能/i,
  "in-vitro": /\bin vitro\b|cell (?:line|culture)|cultured cells|[A-Z0-9-]+ cells|体外|细胞系|细胞实验/i,
  animal: /\b(?:mice|mouse|rats|rat|animal model|zebrafish)\b|小鼠|大鼠|动物模型|斑马鱼/i,
  clinical: /\b(?:clinical trial|clinical study|randomi[sz]ed|phase [123iv]+ trial|enrolled patients|participants were)\b|临床试验|随机对照|受试者|患者入组/i,
};
const normalized = (v: string) => collapseWhitespace(scientificText(v)).toLowerCase();
export type ResearchSupport = Record<string, string>;
export type ResearchRejections = Record<string, string>;
function comparisons(text: string): string[] {
  const canonical = text.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/≤|<=/g,"≤").replace(/≥|>=/g,"≥");
  return [...canonical.matchAll(/(≤|≥|<|>)\s*(\d+(?:\.\d+)?)/g)].map(m=>m[1]+m[2]);
}
export function researchReady(profile: ResearchProfile): boolean {
  const c = profile.claims;
  return profile.documentType === "review" ? !!(c.object && c.results)
    : profile.documentType === "original-research" || profile.documentType === "methods-resources" ? !!(c.object && c.methods && c.results)
    : !!(c.object && c.results);
}
/** Accept only claims accompanied by a verbatim excerpt from the material read by the model. */
export function validateResearchExtraction(value: unknown, material: ResearchMaterial): { profile: ResearchProfile; support: ResearchSupport; rejections: ResearchRejections } {
  const profile = baselineResearch(material);
  const support: ResearchSupport = {};
  const rejections: ResearchRejections = {};
  if (profile.status === "insufficient") return { profile, support, rejections: { material: "insufficient-material" } };
  const v = record(value);
  const corpus = normalized(`${material.title}\n${material.bodyText || material.excerpt || ""}`);
  const supported = (input: unknown, key: string): Record<string, any> | null => {
    const entry = record(input);
    if (!input) return null;
    // Never turn a clipped quotation into apparently complete evidence.
    if (typeof entry.quote === "string" && entry.quote.length > 500) { rejections[key] = "quote-too-long"; return null; }
    const quote = string(entry.quote, 500);
    if (!quote || normalized(quote).length < 12) { rejections[key] = "quote-missing-or-too-short"; return null; }
    if (!corpus.includes(normalized(quote))) { rejections[key] = "quote-not-in-material"; return null; }
    support[key] = quote;
    return entry;
  };
  for (const [field, vocabulary] of [["areas", RESEARCH_AREAS], ["foci", RESEARCH_FOCI], ["evidenceStages", EVIDENCE_STAGES]] as const) {
    const values: string[] = [];
    for (const entry of Array.isArray(v[field]) ? v[field].slice(0, 8) : []) {
      const value = record(entry).value;
      if (!vocabulary.some(x => x.key === value)) { rejections[`${field}.${String(value ?? "invalid")}`] = "unsupported-value"; continue; }
      const accepted = supported(entry, `${field}.${value}`);
      if (!accepted) continue;
      if (field === "foci" && !focusSupported(value, String(accepted.quote), material)) { delete support[`${field}.${value}`]; rejections[`${field}.${value}`] = "outside-topic-boundary"; continue; }
      if (field === "evidenceStages") {
        const quote = String(accepted.quote);
        const cellOnly = value === "animal" && /\b(?:murine|mouse|rat)[ -](?:derived[ -])?(?:cell|macrophage|fibroblast)|(?:mice|mouse|rat)\s+cell|小鼠.*细胞/i.test(quote) && !/\b(?:treated|administered|injected|in vivo|animal model|mice were|rats were)\b|动物模型|体内|给药/i.test(quote);
        if (!stagePatterns[value]!.test(quote) || cellOnly || (value === "clinical" && /\b(?:no|not|without|future|warrant|before|preclinical)\b.{0,40}\bclinical|未.*临床|尚无.*临床/i.test(quote))) { delete support[`${field}.${value}`]; rejections[`${field}.${value}`] = "stage-not-supported"; continue; }
      }
      values.push(value);
    }
    // Deterministic topic hints remain useful while the model leaves a facet empty.
    if (values.length || field !== "areas") (profile[field] as string[]) = [...new Set(values)];
  }
  const doc = supported(v.documentType, "documentType");
  if (doc && DOCUMENT_TYPES.some(x => x.key === doc.value)) {
    const known = profile.documentType;
    if ((known === "review" || known === "news-policy" || known === "methods-resources") && doc.value !== known) { delete support.documentType; rejections.documentType = "conflicts-with-source-metadata"; }
    else profile.documentType = doc.value;
  }
  const origin = supported(v.origin, "origin");
  if (origin && SOURCE_ORIGINS.some(x => x.key === origin.value)) profile.origin = origin.value;
  // The publisher's own metadata outranks an inferred role from the text it reports.
  if (isSecondary(profile.bibliography)) { profile.origin = "secondary"; profile.documentType = "news-policy"; }
  const phase = supported(v.clinicalPhase, "clinicalPhase");
  if (phase && profile.documentType === "original-research" && profile.origin === "primary" && profile.evidenceStages.includes("clinical") && /^(?:I|II|III|IV|1|2|3|4)(?:\/(?:I|II|III|IV|1|2|3|4))?$/.test(String(phase.value))) {
    const roman: Record<string, string> = { I: "1", II: "2", III: "3", IV: "4" };
    const wanted = String(phase.value).split("/").map(x => roman[x] || x).join("/");
    const cited = String(phase.quote).match(/(?:phase|第)\s*(IV|III|II|I|[1-4])(?:\s*\/\s*(IV|III|II|I|[1-4]))?/i);
    if (cited && [cited[1], cited[2]].filter(Boolean).map(x => roman[x!.toUpperCase()] || x).join("/") === wanted) profile.clinicalPhase = String(phase.value);
  }
  if (phase && !profile.clinicalPhase) { delete support.clinicalPhase; rejections.clinicalPhase = "phase-requires-original-clinical-study"; }
  for (const c of RESEARCH_CLAIMS) {
    const entry = supported(record(v.claims)[c.key], `claims.${c.key}`);
    if (entry && typeof entry.text === "string" && entry.text.length > (c.key === "results" ? 800 : 600)) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "claim-too-long"; continue; }
    const text = entry && string(entry.text, c.key === "results" ? 800 : 600);
    if (!text) continue;
    const numbers = text.match(/\d+(?:\.\d+)?/g) || [];
    const citedNumbers = new Set(String(entry.quote).match(/\d+(?:\.\d+)?/g) || []);
    if (numbers.some(n => !citedNumbers.has(n))) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "numbers-not-in-quote"; continue; }
    if (comparisons(text).some(comparison => !comparisons(String(entry.quote)).includes(comparison))) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "comparison-not-in-quote"; continue; }
    if ((!profile.evidenceStages.includes("clinical") || profile.documentType === "review") && /临床疗效|临床有效|患者获益|已获批|治愈/.test(text)) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "unsupported-clinical-conclusion"; continue; }
    if (c.key === "limitations" && /未(?:报告|说明|提供|提及)|没有(?:报告|说明|提供)|not (?:reported|provided|described)/i.test(text) && !/not (?:reported|provided|described)|未(?:报告|说明|提供|提及)/i.test(String(entry.quote))) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "material-scope-is-not-study-limitation"; continue; }
    if (c.key === "results" && /bibliometric|scientometric|文献计量/i.test(corpus) && /证实.*(?:药效|疗效|治疗效果)|验证.*(?:药效|疗效)|改善.*(?:疾病|症状)/.test(text) && /bibliometric|publication|citation|trend|hotspot|文献|趋势|热点/i.test(String(entry.quote))) { delete support[`claims.${c.key}`]; rejections[`claims.${c.key}`] = "bibliometric-is-not-efficacy"; continue; }
    profile.claims[c.key] = text;
  }
  profile.status = researchReady(profile) ? "ready" : "pending";
  return { profile, support, rejections };
}
/** Stored/manual public profiles are still allowlisted; private extraction evidence is separate. */
export function publicResearch(value: unknown, fallback: ResearchProfile): ResearchProfile {
  const v = record(value);
  if (v.version !== 1) return fallback;
  const out = { ...fallback, bibliography: fallback.bibliography, claims: { ...fallback.claims } };
  const pick = (values: unknown, vocab: readonly { key: string }[]) => strings(values, 8).filter(x => vocab.some(y => y.key === x));
  out.areas = pick(v.areas, RESEARCH_AREAS) as ResearchProfile["areas"];
  out.foci = pick(v.foci, RESEARCH_FOCI) as ResearchProfile["foci"];
  out.evidenceStages = pick(v.evidenceStages, EVIDENCE_STAGES) as ResearchProfile["evidenceStages"];
  out.documentType = DOCUMENT_TYPES.some(x => x.key === v.documentType) ? v.documentType : null;
  out.origin = SOURCE_ORIGINS.some(x => x.key === v.origin) ? v.origin : "unknown";
  out.basis = ["fulltext", "abstract", "title", "insufficient"].includes(v.basis) ? v.basis : fallback.basis;
  out.status = ["ready", "pending", "insufficient"].includes(v.status) ? v.status : fallback.status;
  out.clinicalPhase = out.documentType === "original-research" && out.evidenceStages.includes("clinical") && /^(?:I|II|III|IV|1|2|3|4)(?:\/(?:I|II|III|IV|1|2|3|4))?$/.test(String(v.clinicalPhase)) ? v.clinicalPhase : null;
  for (const c of RESEARCH_CLAIMS) out.claims[c.key] = string(record(v.claims)[c.key], 800);
  out.status = researchReady(out) ? "ready" : "pending";
  if (out.basis === "title" || out.basis === "insufficient") { out.evidenceStages = []; out.clinicalPhase = null; out.claims = fallback.claims; out.status = "insufficient"; }
  return out;
}

/** Recheck stored/editorial quotes whenever the projection is rebuilt, including source updates. */
export function supportedStoredResearch(value: unknown, evidence: unknown, material: ResearchMaterial): ResearchProfile {
  const v = record(value), quotes = record(evidence);
  if (v.version !== 1) return baselineResearch(material);
  const extraction: Record<string, unknown> = {};
  for (const field of ["areas", "foci", "evidenceStages"] as const) {
    extraction[field] = strings(v[field], 8).map(value => ({ value, quote: quotes[`${field}.${value}`] }));
  }
  for (const field of ["documentType", "origin", "clinicalPhase"] as const) {
    extraction[field] = { value: v[field], quote: quotes[field] };
  }
  extraction.claims = Object.fromEntries(RESEARCH_CLAIMS.map(c => [c.key, { text: record(v.claims)[c.key], quote: quotes[`claims.${c.key}`] }]));
  return validateResearchExtraction(extraction, material).profile;
}

/** Admin corrections use the same evidence gate and fail visibly instead of dropping invalid edits. */
export function validateAdminResearch(value: unknown, material: ResearchMaterial) {
  const v = record(value);
  const accepted = validateResearchExtraction(v, material);
  const invalid: string[] = [];
  for (const field of ["areas", "foci", "evidenceStages"] as const) {
    for (const entry of Array.isArray(v[field]) ? v[field] : []) {
      if (!(accepted.profile[field] as string[]).includes(record(entry).value) || !accepted.support[`${field}.${record(entry).value}`]) invalid.push(field);
    }
  }
  for (const key of ["documentType", "origin", "clinicalPhase"] as const) if (record(v[key]).value && accepted.profile[key] !== record(v[key]).value) invalid.push(key);
  for (const c of RESEARCH_CLAIMS) if (record(record(v.claims)[c.key]).text && !accepted.profile.claims[c.key]) invalid.push(c.key);
  if (invalid.length) throw Object.assign(new Error(`来源依据不足，无法发布：${[...new Set(invalid)].join("、")}。请填写已获取材料中的原文片段。`), { statusCode:400 });
  return accepted;
}
