import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { overrideFields } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { loadPool } from "@aihot/backend/publication/pool";
import { normalizeBibliography, validateResearchExtraction } from "@aihot/backend/research/profile";
import { backfillResearch } from "@aihot/backend/research/backfill";
import { RESEARCH_PROCESSING_VERSION, researchMaterialFingerprint } from "@aihot/backend/research/material";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), sourceId = `editorial-material-${T}`;
const abstract = "We investigated a natural compound for drug discovery. We tested cultured cells in vitro with a viability assay. Treatment reduced cell viability by 25 percent.";
const animalQuote = "Mice received the study drug in vivo.";
const animalResult = "Treatment reduced tumor volume by 42 percent.";
const privateMarker = `PRIVATE-SOURCE-${T}`;
const supplementary = `${abstract}\nSupplementary Figure: ${animalQuote} ${animalResult}\n${privateMarker}`;
const sources = [{ label: "论文摘要", url: "https://example.org/article" }, { label: "公开补充材料", url: "https://example.org/supplement.docx" }];
const manual = { kind: "abstract-supplement", text: supplementary, sources };
const object = { text: "研究天然化合物。", quote: "We investigated a natural compound for drug discovery." };
const baseClaims = { object, methods: { text: "开展体外细胞实验。", quote: "We tested cultured cells in vitro with a viability assay." }, results: { text: "细胞活性降低25%。", quote: "Treatment reduced cell viability by 25 percent." } };
const animalExtraction = { evidenceStages: [{ value: "animal", quote: animalQuote }], claims: { object, methods: { text: "开展小鼠体内实验。", quote: animalQuote }, results: { text: "肿瘤体积降低42%。", quote: animalResult } } };

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext) VALUES (${sourceId},${sourceId},'rss','T1','editorial',true)`;
});
after(async () => {
  await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE source_id=${sourceId}`;
  await stopBoss();
  await closeDb();
});

let serial = 0;
async function article() {
  const n = ++serial;
  const bibliography = normalizeBibliography({ doi: `10.1234/${T}-${n}`, journal: "Editorial Test Journal", publicationTypes: ["Journal Article"] });
  const title = `Natural compound drug study ${T} ${n}`;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/${T}/${n}`, title, bodyText: abstract, bodyHtml: `<p>${abstract}</p>`, bodyStatus: "ok", bibliography, via: "fetch" });
  const result = validateResearchExtraction({ evidenceStages: [{ value: "in-vitro", quote: baseClaims.methods.quote }], claims: baseClaims }, { title, bodyText: abstract, bibliography });
  await sql`UPDATE articles SET research_abstract=${abstract},research_material_kind='paper-abstract',research_profile=${sql.json(result.profile as never)},
    research_support=${sql.json(result.support)},research_revision=revision,processing_state='analyzed',backfill=true WHERE id=${articleId}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category)
    VALUES (${articleId},1,'rule','pass',${`人工材料测试 ${T} ${n}`},'基础摘要',70,false,'paper')`;
  await publishArticle(articleId);
  return articleId;
}

test("supplemental evidence passes the admin gate, stays private, is audited and survives automatic backfill", async () => {
  const id = await article();
  await assert.rejects(overrideFields(id, { fields: { research: animalExtraction }, reason: "没有补充材料时拒收", version: 0 }, "test-editor"), /来源依据不足/);
  await overrideFields(id, { fields: { researchMaterial: manual, research: animalExtraction, selected: true }, reason: "核对摘要及补充材料", version: 0 }, "test-editor");
  let [publication] = await sql`SELECT research,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.basis, "abstract");
  assert.equal(publication!.research.materialKind, "abstract-supplement");
  assert.deepEqual(publication!.research.evidenceStages, ["animal"]);
  assert.deepEqual(publication!.research.materialSources, sources);
  assert.equal(publication!.selected, true);
  const [stored] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${id}`;
  assert.deepEqual(stored!.fields.researchMaterial, manual);
  assert.equal(stored!.version, 1);
  const [original] = await sql`SELECT research_abstract,body_text FROM articles WHERE id=${id}`;
  assert.equal(original!.research_abstract, abstract);
  assert.equal(original!.body_text, abstract);
  const [audit] = await sql`SELECT "after" FROM audit_log WHERE subject=${`content:${id}`} AND action='content.override' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(audit!.after.researchMaterial, manual);
  await assert.rejects(overrideFields(id, { fields: { researchMaterial: null }, reason: "过期版本", version: 0 }, "test-editor"), /刷新/);

  // Real backfill reuses its existing extraction without a model/provider or external material fetch.
  const input = (await loadAnalyzeInput(id))!;
  await sql`UPDATE articles SET research_processing_version=${RESEARCH_PROCESSING_VERSION},research_material_fingerprint=${researchMaterialFingerprint(input)},research_enriched_at=NULL WHERE id=${id}`;
  const previous = { backfill: process.env.RESEARCH_BACKFILL_ENABLED, models: process.env.MODEL_CALLS_ENABLED };
  const [beforeReceipts] = await sql`SELECT count(*)::int AS n FROM receipts`;
  try {
    process.env.RESEARCH_BACKFILL_ENABLED = "true";
    process.env.MODEL_CALLS_ENABLED = "true";
    const done = await backfillResearch({ limit: 1, articleIds: [id], enrichMaterial: async () => {} });
    assert.equal(done.processed, 1);
  } finally {
    if (previous.backfill === undefined) delete process.env.RESEARCH_BACKFILL_ENABLED; else process.env.RESEARCH_BACKFILL_ENABLED = previous.backfill;
    if (previous.models === undefined) delete process.env.MODEL_CALLS_ENABLED; else process.env.MODEL_CALLS_ENABLED = previous.models;
    await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE id=${id}`;
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, beforeReceipts!.n);
  [publication] = await sql`SELECT research,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.claims.results, "肿瘤体积降低42%。");
  assert.deepEqual(publication!.research.materialSources, sources);
  assert.deepEqual((await sql`SELECT fields FROM editorial_overrides WHERE article_id=${id}`)[0]!.fields.researchMaterial, manual);

  const detail = await loadItemDetail(id);
  assert.equal(detail.kind, "found");
  const publicData = JSON.stringify({ publication: publication!.research, detail: detail.kind === "found" ? detail.detail : null,
    pool: await loadPool({ channel: "all", category: null, tag: null, q: T }), markdown: await exportMarkdown(id) });
  for (const secret of [privateMarker, animalQuote, animalResult, '"researchSupport"', '"researchMaterial"']) assert.ok(!publicData.includes(secret), secret);
  const [search] = await sql`SELECT direct,body FROM pool_search WHERE article_id=${id}`;
  assert.ok(!JSON.stringify(search).includes(privateMarker));
});

test("full text sets basis centrally and clearing it removes unsupported fields, quotes, sources and selection", async () => {
  const id = await article();
  const oldSummary = `旧人工全文结论-${T}`, oldReason = `旧人工全文精选理由-${T}`;
  await overrideFields(id, { fields: { researchMaterial: { ...manual, kind: "fulltext" }, research: animalExtraction, selected: true,
    summary: oldSummary, reason: oldReason }, reason: "阅读全文", version: 0 }, "test-editor");
  let [publication] = await sql`SELECT research,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.basis, "fulltext");
  assert.equal(publication!.research.materialKind, "fulltext");
  assert.equal(publication!.selected, true);
  await overrideFields(id, { fields: {}, clear: ["researchMaterial"], reason: "清除失效全文材料", version: 1 }, "test-editor");
  await publishArticle(id);
  [publication] = await sql`SELECT research,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.basis, "abstract");
  assert.equal(publication!.research.materialKind, "paper-abstract");
  assert.equal(publication!.research.claims.object, "研究天然化合物。");
  assert.equal(publication!.research.claims.methods, null);
  assert.equal(publication!.research.claims.results, null);
  assert.deepEqual(publication!.research.evidenceStages, []);
  assert.equal(publication!.research.materialSources, undefined);
  assert.equal(publication!.research.status, "pending");
  assert.equal(publication!.selected, false);
  const [stored] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${id}`;
  assert.equal(stored!.fields.researchMaterial, undefined);
  assert.equal(stored!.fields.researchSupport["evidenceStages.animal"], undefined);
  assert.equal(stored!.fields.researchSupport["claims.results"], undefined);
  assert.equal(stored!.version, 2);
  assert.equal(stored!.fields.summary, undefined);
  assert.equal(stored!.fields.reason, undefined);
  assert.equal(stored!.fields.selected, false);
  const detail = await loadItemDetail(id);
  const publicAfterClear = JSON.stringify({ detail: detail.kind === "found" ? detail.detail : null,
    pool: await loadPool({ channel: "all", category: null, tag: null, q: T }), markdown: await exportMarkdown(id),
    currentPublication: (await sql`SELECT title,summary,reason,research FROM publications WHERE article_id=${id}`)[0] });
  assert.ok(!publicAfterClear.includes(oldSummary));
  assert.ok(!publicAfterClear.includes(oldReason));
  const [state] = await sql`SELECT in_set FROM selected_state WHERE article_id=${id}`;
  assert.equal(state!.in_set, false);
});

test("replacing material alone revalidates old fields; mismatching new quotes cannot commit", async () => {
  const id = await article();
  await overrideFields(id, { fields: { researchMaterial: manual, research: animalExtraction }, reason: "先保存已核对材料", version: 0 }, "test-editor");
  const replacement = { kind: "abstract-supplement", text: abstract, sources: [sources[0]] };
  await assert.rejects(overrideFields(id, { fields: { researchMaterial: replacement, research: animalExtraction }, reason: "材料不匹配", version: 1 }, "test-editor"), /来源依据不足/);
  let [stored] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${id}`;
  assert.equal(stored!.version, 1);
  assert.deepEqual(stored!.fields.researchMaterial, manual);
  await overrideFields(id, { fields: { researchMaterial: replacement }, reason: "替换后重新核对旧字段", version: 1 }, "test-editor");
  [stored] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${id}`;
  assert.equal(stored!.fields.research.claims.results, null);
  assert.deepEqual(stored!.fields.research.evidenceStages, []);
  assert.equal(stored!.fields.researchSupport["evidenceStages.animal"], undefined);
  const [publication] = await sql`SELECT research FROM publications WHERE article_id=${id}`;
  assert.deepEqual(publication!.research.materialSources, replacement.sources);
  await overrideFields(id, { fields: { researchMaterial: null }, reason: "清除人工材料", version: 2 }, "test-editor");
  assert.equal((await sql`SELECT fields FROM editorial_overrides WHERE article_id=${id}`)[0]!.fields.researchMaterial, undefined);
});

test("existing abstract-only corrections keep their original material scope and validation", async () => {
  const id = await article();
  await overrideFields(id, { fields: { research: { evidenceStages: [{ value: "in-vitro", quote: baseClaims.methods.quote }], claims: baseClaims } }, reason: "沿用摘要校正", version: 0 }, "test-editor");
  await publishArticle(id);
  const [publication] = await sql`SELECT research FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.basis, "abstract");
  assert.equal(publication!.research.materialKind, "paper-abstract");
  assert.equal(publication!.research.materialSources, undefined);
  assert.equal(publication!.research.claims.results, "细胞活性降低25%。");
  assert.equal(publication!.research.status, "ready");
  await assert.rejects(overrideFields(id, { fields: { researchMaterial: { ...manual, sources: [{ label: "Invalid", url: "javascript:alert(1)" }] } }, reason: "无效材料地址", version: 1 }, "test-editor"));
  assert.equal((await sql`SELECT version FROM editorial_overrides WHERE article_id=${id}`)[0]!.version, 1);
});

test("bibliography-only corrections do not capture automated research or block later automated updates", async () => {
  const id = await article();
  const [original] = await sql`SELECT bibliography,research_profile,research_support FROM articles WHERE id=${id}`;
  await overrideFields(id, { fields: { researchBibliography: { ...original!.bibliography, journal: "Corrected Journal" } }, reason: "只改期刊名", version: 0 }, "test-editor");
  let [stored] = await sql`SELECT fields FROM editorial_overrides WHERE article_id=${id}`;
  assert.equal(stored!.fields.research, undefined);
  assert.equal(stored!.fields.researchSupport, undefined);
  const updated = { ...original!.research_profile, claims: { ...original!.research_profile.claims, results: "细胞活性下降25%。" } };
  await sql`UPDATE articles SET research_profile=${sql.json(updated as never)} WHERE id=${id}`;
  await publishArticle(id);
  let [publication] = await sql`SELECT research FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.claims.results, "细胞活性下降25%。");
  assert.equal(publication!.research.bibliography.journal, "Corrected Journal");
  await overrideFields(id, { fields: {}, clear: ["researchBibliography"], reason: "恢复原始书目", version: 1 }, "test-editor");
  [stored] = await sql`SELECT fields FROM editorial_overrides WHERE article_id=${id}`;
  assert.equal(stored!.fields.research, undefined);
  [publication] = await sql`SELECT research FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.claims.results, "细胞活性下降25%。");
  assert.equal(publication!.research.bibliography.journal, original!.bibliography.journal);
});

test("a material change requires fresh editorial selection even when all old claims still validate", async () => {
  const id = await article();
  await overrideFields(id, { fields: { researchMaterial: manual, research: animalExtraction, selected: true, summary: "旧导读", reason: "旧精选理由" }, reason: "首次编辑", version: 0 }, "test-editor");
  await overrideFields(id, { fields: { researchMaterial: { ...manual, text: supplementary + " Additional study limitations were discussed." } }, reason: "补充研究材料", version: 1 }, "test-editor");
  let [publication] = await sql`SELECT research,summary,reason,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.status, "ready");
  assert.equal(publication!.summary, "肿瘤体积降低42%。");
  assert.equal(publication!.reason, null);
  assert.equal(publication!.selected, false);
  await overrideFields(id, { fields: { researchMaterial: { ...manual, kind: "fulltext" }, selected: true, summary: "重新核对后的导读", reason: "重新核对后的精选理由" }, reason: "本次明确重审导读与精选", version: 2 }, "test-editor");
  [publication] = await sql`SELECT research,summary,reason,selected FROM publications WHERE article_id=${id}`;
  assert.equal(publication!.research.basis, "fulltext");
  assert.equal(publication!.summary, "重新核对后的导读");
  assert.equal(publication!.reason, "重新核对后的精选理由");
  assert.equal(publication!.selected, true);
});
