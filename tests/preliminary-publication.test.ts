import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { overrideFields } from "@aihot/backend/admin/content";
import { processArticle } from "@aihot/backend/jobs/content";
import { validateResearchExtraction } from "@aihot/backend/research/profile";
import { loadPool } from "@aihot/backend/publication/pool";
import { v1Items } from "@aihot/backend/publication/v1";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { preliminaryAdmission, preliminaryResearch, type PreliminaryInput } from "@aihot/backend/publication/preliminary";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary } from "@aihot/backend/publication/items";
import { INDEX_CONTENT_SUMMARY } from "@aihot/contracts/site";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import type { Bibliography } from "@aihot/contracts/research";

const now = new Date();
const date = now.toISOString().slice(0,10);
const b: Bibliography = { doi: "10.1234/index-study", pmid: "98765432", journal: "Test Pharmacology", authors: ["A Researcher"], publishedDate: date, publicationTypes: ["Journal Article"], isPreprint: false };
const source = { kind: "json_list", participation_mode: "editorial", config: { preliminaryIndex: true, url: "https://www.ebi.ac.uk/europepmc/webservices/rest/search" } };
function fixture(): PreliminaryInput {
  return { source, article: { url: "https://europepmc.org/article/MED/98765432", title: "Drug discovery using machine learning", published_at: new Date(`${date}T00:00:00Z`), bibliography: b, processing_state: "new", canonical_article_id: null }, material: { title: "Drug discovery using machine learning", bibliography: b }, now };
}

after(async () => { await stopBoss(); await closeDb(); });

test("early index requires explicit pharmacy relevance and the source's own record", () => {
  assert.equal(preliminaryAdmission(fixture()), true);
  for (const patch of [
    { title: "Large language models for general image classification" },
    { title: "Plant toxicity and herbicide discovery for crop protection" },
    { title: "Natural products for treatment of crop disease" },
    { title: "Natural products for plant treatment" },
    { title: "Antibacterial natural products for food preservation" },
    { title: "Antibacterial natural products protect medicinal plants against crop disease" },
    { bibliography: { ...b, pmid: "222" } },
    { bibliography: { ...b, doi: null, pmid: null } },
    { bibliography: { ...b, journal: null } },
    { bibliography: { ...b, publishedDate: new Date(now.getTime()-86400_000).toISOString().slice(0,10) } },
    { published_at: new Date(now.getTime()+86400_000) },
    { processing_state: "blocked" },
    { canonical_article_id: "canonical" },
    { url: "https://example.org/article/MED/98765432" },
  ]) { const f = fixture(); Object.assign(f.article, patch); f.material.title = f.article.title; assert.equal(preliminaryAdmission(f), false, JSON.stringify(patch)); }
  assert.equal(preliminaryAdmission({ ...fixture(), source: { ...source, config: { ...source.config, preliminaryIndex: false } } }), false);
  assert.equal(preliminaryAdmission({ ...fixture(), source: { ...source, participation_mode: "isolated" } }), false);
  const dual = fixture(); dual.article.title = "Food-derived compounds for anticancer drug discovery"; dual.material.title = dual.article.title;
  assert.equal(preliminaryAdmission(dual), true);
  const references = fixture(); references.article.title = "General natural products analysis"; references.material.title = references.article.title;
  references.material.bodyText = "References: Drug discovery 10.1234/a 10.1234/b 10.1234/c ".repeat(4);
  assert.equal(preliminaryAdmission(references), false);
  const p = preliminaryResearch({ title: "Drug discovery using machine learning", bibliography: b });
  assert.deepEqual(p.evidenceStages, []); assert.deepEqual(p.foci, []); assert.deepEqual(p.areas, []);
  assert.ok(Object.values(p.claims).every(v => v === null)); assert.equal(p.status, "pending");
});

test("promoting a public index keeps it readable while selected-only exits retain the release gate", async () => {
  const id = `early-selected-${randomUUID()}`;
  const pmid = String(Date.now()).slice(-11);
  const bibliography = { ...b, pmid, doi: `10.1234/${id}` };
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,next_fetch_at)
    VALUES(${id},'Early selection','json_list','T1','editorial',${sql.json(source.config)},'2100-01-01')`;
  const text = "We studied drug candidates using machine learning. We screened candidate molecules in a benchmark and identified three hits. ".repeat(3);
  const material = { title: fixture().article.title, bibliography, bodyText: text };
  const u = await upsertMaterial({ sourceId: id, url: `https://europepmc.org/article/MED/${pmid}`, title: material.title, bibliography, bodyText: text, bodyStatus: "ok", publishedAt: now, via: "fetch" });
  await publishArticle(u.articleId, { now });
  const out = validateResearchExtraction({ claims: { object: { text: "drug candidates", quote: "We studied drug candidates using machine learning." }, methods: { text: "screened candidate molecules in a benchmark", quote: "We screened candidate molecules in a benchmark and identified three hits." }, results: { text: "identified three hits", quote: "We screened candidate molecules in a benchmark and identified three hits." } } }, material);
  assert.equal(out.profile.status, "ready");
  await sql`UPDATE articles SET research_profile=${sql.json(out.profile as never)}, research_support=${sql.json(out.support)}, research_revision=revision WHERE id=${u.articleId}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${u.articleId},1,'rule','pass',${`已核对精选研究 ${id}`},'已整理','研究价值',90,true)`;
  const promotingAt = new Date(now.getTime() + 60000);
  await publishArticle(u.articleId, { now: promotingAt });
  const [p] = await sql`SELECT visible_after,first_public_at FROM publications WHERE article_id=${u.articleId}`;
  assert.ok(p.visible_after > promotingAt); assert.equal(p.first_public_at.toISOString(), now.toISOString());
  const pool = await loadPool({ channel: "all", category: null, tag: null, q: id, now: promotingAt, timeBasis: "publication" });
  const item = pool.items.find(v => v.id === u.articleId); assert.ok(item); assert.equal(item.selected, false); assert.equal(item.reason, null);
  assert.ok(!(await loadPool({ channel: "all", category: null, tag: null, now: promotingAt, selectedOnly: true })).items.some(v => v.id === u.articleId));
  const query = { window: "7d" as const, by: "published" as const, category: null, q: id, limit: 200, cursor: null };
  const all = await v1Items({ ...query, mode: "all" }, promotingAt); assert.equal(all.items.find(v => v.id === u.articleId)?.selected, false);
  assert.ok(!(await v1Items({ ...query, mode: "selected" }, promotingAt)).items.some(v => v.id === u.articleId));
  assert.ok((await itemFeed("all", null, promotingAt)).includes(u.articleId));
  assert.ok(!(await itemFeed("selected", null, promotingAt)).includes(u.articleId));
});

test("free DOI reconciliation withdraws already-public aliases even when the model budget waits", async () => {
  const id = `early-alias-${randomUUID()}`;
  const doi = `10.1038/${id}`, slug = id;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,next_fetch_at)
    VALUES(${id},'Nature DOI correction','rss','T1','editorial',${sql.json({ preliminaryIndex: true, feedUrl: "https://www.nature.com/nrd.rss" })},'2100-01-01')`;
  const first = await upsertMaterial({ sourceId: id, url: `https://www.nature.com/articles/${slug}`, title: 'Drug pharmacology test', publishedAt: new Date(), bodyText: 'We tested drug candidates in a pharmacological model. '.repeat(5), bodyStatus: 'ok', via: 'fetch' });
  const second = await upsertMaterial({ sourceId: id, url: `https://www.nature.com/articles/${slug}-alias`, title: 'Drug pharmacology duplicate', publishedAt: new Date(), bodyText: 'We tested drug candidates in a pharmacological model. '.repeat(5), bodyStatus: 'ok', via: 'fetch' });
  for (const articleId of [first.articleId, second.articleId]) {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass','药物研究','旧公开资料',60,false)`;
    await publishArticle(articleId);
  }
  await sql`UPDATE articles SET bibliography=${sql.json({ ...b, doi, publishedDate: new Date().toISOString().slice(0,10) })} WHERE id IN (${first.articleId},${second.articleId})`;
  // New revision requires a paid step, which is blocked by a stopped local budget.
  await sql`UPDATE articles SET revision=2,processing_state='new' WHERE id=${second.articleId}`;
  const [limit] = await sql`SELECT * FROM budgets WHERE service='dashscope'`;
  process.env.DASHSCOPE_API_KEY = "test-local-key";
  process.env.DASHSCOPE_BASE_URL = "http://127.0.0.1:9/v1";
  await sql`UPDATE budgets SET per_minute=0 WHERE service='dashscope'`;
  try {
    await assert.rejects(processArticle(second.articleId), BudgetExceededError);
    const rows = await sql`SELECT p.article_id,p.eligible,p.selected,a.canonical_article_id FROM publications p JOIN articles a ON a.id=p.article_id WHERE p.article_id IN (${first.articleId},${second.articleId})`;
    assert.equal(rows.filter(v => v.eligible).length, 1); assert.equal(rows.find(v => v.canonical_article_id)?.eligible, false);
    assert.equal((await loadItemDetail(second.articleId)).kind, "found");
  } finally {
    await sql`UPDATE budgets SET per_minute=${limit.per_minute} WHERE service='dashscope'`;
  }
});

test("publisher metadata must identify the current Nature article, including secondary news", () => {
  const f = fixture(); f.source = { kind: "rss", participation_mode: "editorial", config: { preliminaryIndex: true, feedUrl: "https://www.nature.com/nrd.rss" } };
  f.article.url = "https://www.nature.com/articles/d41573-026-00123-4";
  f.article.bibliography = { ...b, pmid: null, doi: "10.1038/d41573-026-00123-4", publicationTypes: ["News In Brief"] };
  f.material.bibliography = f.article.bibliography;
  assert.equal(preliminaryAdmission(f), true);
  assert.equal(preliminaryResearch(f.material).origin, "secondary");
  f.article.bibliography = { ...b, doi: "10.1038/reported-study" };
  assert.equal(preliminaryAdmission(f), false);
});

test("index publishes without a model, then promotes at the same ID and retains first-public time", async () => {
  const id = `early-${randomUUID()}`;
  const pmid = String(parseInt(randomUUID().replaceAll("-", "").slice(0,8),16));
  const bibliography = { ...b, pmid, doi: `10.1234/${id}` };
  const url = `https://europepmc.org/article/MED/${pmid}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES(${id},'Europe PMC early index','json_list','T1','editorial',${sql.json(source.config)},true,true,'2100-01-01')`;
  const u = await upsertMaterial({ sourceId: id, title: fixture().article.title, url, publishedAt: fixture().article.published_at, bibliography, bodyText: 'Private acquired abstract about drug discovery. '.repeat(10), bodyHtml: '<p>PRIVATE-ABSTRACT</p>', bodyStatus: 'ok', via: 'fetch' });
  await publishArticle(u.articleId, { now });
  const [p] = await sql`SELECT * FROM publications WHERE article_id=${u.articleId}`;
  assert.equal(p.eligible, true); assert.equal(p.selected, false); assert.equal(p.index_only, true);
  assert.equal(p.summary, INDEX_CONTENT_SUMMARY); assert.equal(p.score, null); assert.equal(p.indexable, false); assert.equal(p.syndicate, false);
  assert.equal(p.first_public_at.toISOString(), now.toISOString());
  const detail = await loadItemDetail(u.articleId, now); assert.equal(detail.kind, "found");
  if (detail.kind !== "found") throw Error("missing index");
  assert.equal(detail.detail.contentStage, "index"); assert.equal(detail.detail.body, null);
  assert.deepEqual(detail.detail.research?.evidenceStages, []);
  const [row] = await sql<any[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id=${u.articleId}`;
  const feed = toFeedItemSummary(row); assert.equal(feed.contentStage, "index"); assert.equal(feed.links?.original, url);
  const md = await exportMarkdown(u.articleId); assert.ok(md?.body.includes("导读整理中")); assert.ok(!md?.body.includes("PRIVATE-ABSTRACT"));
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${u.articleId},1,'rule','pass','ai-pharma','已核对的药物发现研究','已整理',60,false)`;
  await publishArticle(u.articleId, { now: new Date(now.getTime() + 60000) });
  const [done] = await sql`SELECT * FROM publications WHERE article_id=${u.articleId}`;
  assert.equal(done.index_only, false); assert.equal(done.eligible, true); assert.equal(done.title, "已核对的药物发现研究");
  assert.equal(done.first_public_at.toISOString(), now.toISOString());
  // A new revision never publishes an earlier revision's inference as current.
  await sql`UPDATE articles SET revision=2, processing_state='new' WHERE id=${u.articleId}`;
  await publishArticle(u.articleId, { now });
  const [revised] = await sql`SELECT * FROM publications WHERE article_id=${u.articleId}`;
  assert.equal(revised.index_only, true); assert.equal(revised.analysis_id, null);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected)
    VALUES(${u.articleId},2,'rule','block','排除','范围外',false)`;
  await sql`UPDATE articles SET processing_state='blocked' WHERE id=${u.articleId}`;
  await publishArticle(u.articleId, { now });
  const [blocked] = await sql`SELECT eligible,index_only FROM publications WHERE article_id=${u.articleId}`;
  assert.equal(blocked.eligible, false); assert.equal(blocked.index_only, false);
  assert.equal((await sql`SELECT 1 FROM pool_search WHERE article_id=${u.articleId}`).length, 0);
});

async function editorialIndex(text: string, publicationTypes = ["Journal Article"]) {
  const key = `early-manual-${randomUUID()}`;
  const pmid = String(parseInt(randomUUID().replaceAll("-", "").slice(0,8),16));
  const bibliography = { ...b, pmid, doi: `10.1234/${key}`, publicationTypes };
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,next_fetch_at)
    VALUES(${key},'Manual index review','json_list','T1','editorial',${sql.json(source.config)},'2100-01-01')`;
  const title = `Drug discovery manually reviewed ${key}`;
  const { articleId } = await upsertMaterial({ sourceId: key, url: `https://europepmc.org/article/MED/${pmid}`, title,
    bibliography, bodyText: text, bodyStatus: "ok", publishedAt: now, via: "fetch" });
  await publishArticle(articleId, { now });
  const [initial] = await sql`SELECT eligible,index_only,summary FROM publications WHERE article_id=${articleId}`;
  assert.equal(initial!.eligible, true); assert.equal(initial!.index_only, true); assert.equal(initial!.summary, INDEX_CONTENT_SUMMARY);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  return { articleId, key };
}

test("an explicit audited relevance pass publishes manual research from an index without inventing an analysis", async () => {
  const object = "We studied candidate molecules for drug discovery.";
  const methods = "We tested the candidates in cultured cells in vitro.";
  const results = "Treatment reduced cell viability compared with the control.";
  const { articleId, key } = await editorialIndex(`${object} ${methods} ${results}`);
  const title = `人工核对的体外药物研究 ${key}`, summary = "候选物在体外细胞实验中降低细胞活力，尚不能推断人体疗效。";
  const research = { evidenceStages: [{ value: "in-vitro", quote: methods }], claims: {
    object: { text: "研究药物候选分子。", quote: object }, methods: { text: "开展体外细胞实验。", quote: methods },
    results: { text: "与对照相比，处理降低细胞活力。", quote: results },
  } };
  await overrideFields(articleId, { fields: { title, summary, research, selected: false }, reason: "核对研究材料，关联尚未裁定", version: 0 }, "test-editor");
  const [unjudged] = await sql`SELECT index_only,research FROM publications WHERE article_id=${articleId}`;
  assert.equal(unjudged!.index_only, true); assert.equal(unjudged!.research.status, "pending");
  await overrideFields(articleId, { fields: { relevance: "pass" }, reason: "确认药学关联并发布已核对导读", version: 1 }, "test-editor");
  const [publication] = await sql`SELECT * FROM publications WHERE article_id=${articleId}`;
  assert.equal(publication!.analysis_id, null); assert.equal(publication!.index_only, false); assert.equal(publication!.eligible, true);
  assert.equal(publication!.title, title); assert.equal(publication!.summary, summary); assert.equal(publication!.research.status, "ready");
  assert.deepEqual(publication!.research.evidenceStages, ["in-vitro"]); assert.equal(publication!.research.claims.results, research.claims.results.text);
  assert.equal(publication!.first_public_at.toISOString(), now.toISOString());
  const pool = await loadPool({ channel: "all", category: null, tag: null, q: key });
  assert.equal(pool.items.find(item => item.id === articleId)?.summary, summary);
  const detail = await loadItemDetail(articleId); assert.equal(detail.kind, "found");
  if (detail.kind !== "found") throw Error("missing manual research");
  assert.equal(detail.detail.summary, summary); assert.equal(detail.detail.research?.status, "ready");
  assert.deepEqual(detail.detail.research?.evidenceStages, ["in-vitro"]);
  const [override] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${articleId}`;
  assert.equal(override!.version, 2); assert.equal(override!.fields.relevance, "pass");
  const [audit] = await sql`SELECT actor,reason,"after" FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.override' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.actor, "test-editor"); assert.equal(audit!.reason, "确认药学关联并发布已核对导读"); assert.equal(audit!.after.relevance, "pass");
  await assert.rejects(overrideFields(articleId, { fields: { relevance: "block" }, reason: "旧版本修改", version: 1 }, "test-editor"), /刷新/);
  await assert.rejects(overrideFields(articleId, { fields: { relevance: "block" }, reason: "", version: 2 }, "test-editor"), /reason is required/);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  await overrideFields(articleId, { fields: {}, clear: ["relevance"], reason: "撤销人工关联判定，恢复待确认索引", version: 2 }, "test-editor");
  const [cleared] = await sql`SELECT index_only,selected,research,first_public_at FROM publications WHERE article_id=${articleId}`;
  assert.equal(cleared!.index_only, true); assert.equal(cleared!.research.status, "pending"); assert.equal(cleared!.selected, false);
  assert.equal(cleared!.first_public_at.toISOString(), now.toISOString());
  const [retained] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${articleId}`;
  assert.equal(retained!.version, 3); assert.equal(retained!.fields.relevance, undefined); assert.equal(retained!.fields.research.status, "ready");
  assert.equal(retained!.fields.research.claims.results, research.claims.results.text); assert.ok(retained!.fields.researchSupport);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
});

test("relevance approval of a short publisher report cannot make incomplete research ready or selected", async () => {
  const quote = "This publisher report describes a drug delivery strategy aimed at releasing payloads at the target cell surface.";
  const { articleId, key } = await editorialIndex(quote + " The acquired preview contains only a general description of this strategy.", ["Research Highlight"]);
  await overrideFields(articleId, { fields: { relevance: "pass", title: `药物递送研究简讯 ${key}`, summary: "简讯只提供策略概述，具体方法和结果待核对。", selected: true,
    research: { claims: { object: { text: "简讯报道细胞表面载荷释放的药物递送策略。", quote } } } }, reason: "确认主题关联，保留材料不足限定", version: 0 }, "test-editor");
  const [publication] = await sql`SELECT eligible,index_only,selected,research,analysis_id FROM publications WHERE article_id=${articleId}`;
  assert.equal(publication!.eligible, true); assert.equal(publication!.index_only, false); assert.equal(publication!.selected, false);
  assert.equal(publication!.analysis_id, null); assert.equal(publication!.research.status, "pending"); assert.equal(publication!.research.origin, "secondary");
  assert.equal(publication!.research.materialKind, "publisher-summary"); assert.equal(publication!.research.claims.results, null);
  const detail = await loadItemDetail(articleId); assert.equal(detail.kind, "found");
  if (detail.kind !== "found") throw Error("missing short report");
  assert.equal(detail.detail.research?.status, "pending"); assert.equal(detail.detail.selected, false);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
});

test("an audited relevance block removes an early index from the pool without inventing an analysis", async () => {
  const { articleId, key } = await editorialIndex("This candidate discovery record needs a manual assessment of its pharmacy scope. ".repeat(2));
  await overrideFields(articleId, { fields: { relevance: "block" }, reason: "核对后确定没有本站要求的药学关联", version: 0 }, "test-editor");
  const [publication] = await sql`SELECT eligible,index_only,selected,analysis_id FROM publications WHERE article_id=${articleId}`;
  assert.equal(publication!.eligible, false); assert.equal(publication!.index_only, false); assert.equal(publication!.selected, false); assert.equal(publication!.analysis_id, null);
  assert.equal((await sql`SELECT 1 FROM pool_search WHERE article_id=${articleId}`).length, 0);
  assert.ok(!(await loadPool({ channel: "all", category: null, tag: null, q: key })).items.some(item => item.id === articleId));
  const [audit] = await sql`SELECT "after" FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.override' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.after.relevance, "block"); assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
});

test("an invalid manual relevance verdict is rejected before creating an override or audit", async () => {
  const { articleId } = await editorialIndex("This drug discovery record retains only source metadata until its material is reviewed. ".repeat(2));
  await assert.rejects(overrideFields(articleId, { fields: { relevance: "maybe" }, reason: "非法关联值", version: 0 }, "test-editor"), error => !!error && typeof error === "object" && "issues" in error);
  assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.override'`).length, 0);
  assert.equal((await sql`SELECT index_only FROM publications WHERE article_id=${articleId}`)[0]!.index_only, true);
});
