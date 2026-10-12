// The analysis input and its commit check must compare the same effective bibliography.
// Every provider response is a local fixture; concurrency tests use real throwaway-DB row locks.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { overrideFields } from "@aihot/backend/admin/content";
import { analyzeArticle, loadAnalyzeInput } from "@aihot/backend/editorial/analyze";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { publishArticle } from "@aihot/backend/publication/publish";
import { normalizeBibliography } from "@aihot/backend/research/profile";
import { RESEARCH_PROCESSING_VERSION, researchMaterialFingerprint } from "@aihot/backend/research/material";
import { backfillResearch } from "@aihot/backend/research/backfill";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), sourceId = `effective-material-${T}`, modelKey = `local-effective-${T}`;
const abstract = "We investigated a natural compound for drug discovery. We tested cultured cells in vitro with a viability assay. Treatment reduced cell viability by 25 percent.";
const bibliography = normalizeBibliography({ journal: "Source Journal", publicationTypes: ["Journal Article"] });
const corrected = { ...bibliography, journal: "Corrected Journal" };
const extraction = {
  claims: {
    object: { text: "研究天然化合物。", quote: "We investigated a natural compound for drug discovery." },
    methods: { text: "开展体外细胞实验。", quote: "We tested cultured cells in vitro with a viability assay." },
    results: { text: "细胞活性降低25%。", quote: "Treatment reduced cell viability by 25 percent." },
  },
  evidenceStages: [{ value: "in-vitro", quote: "We tested cultured cells in vitro with a viability assay." }],
};
const holds = new Map<string, { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> }>();
const withoutResearch = new Set<string>();
const provider = await stub(async (hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages[0]?.role === "system" ? body.messages[0].content : "";
  const user = body.messages.at(-1)!.content;
  const answer = (content: unknown) => ({ id: `stub-${hit}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (system.includes("宽召回的药学相关性预筛")) return answer({ label: "PASS", reason: "本地药学样本" });
  if (system.includes("事件注意力评分器")) return answer({ attentionScore: 40 });
  if (system.includes('只返回 JSON 对象 {"research":研究结构对象}。')) {
    for (const [marker, hold] of holds) if (user.includes(marker)) { hold.entered.open(); await hold.release.promise; }
    return answer({ research: { ...extraction, areas: [], foci: [] } });
  }
  if (system.includes("资料结构化助手")) {
    for (const [marker, hold] of holds) if (user.includes(marker)) { hold.entered.open(); await hold.release.promise; }
    return answer({ category: "paper", tags: [], subjects: [], fact: null,
      ...(Array.from(withoutResearch).some(marker => user.includes(marker)) ? {} : { research: extraction }) });
  }
  assert.ok(user.includes("title_zh"), "only the expected local summary prompt may run");
  return answer("title_zh: 天然化合物体外研究\nsummary_zh: 细胞活性降低25%。");
});
const capabilityEnvs = ["PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL", "STRUCTURE_MODEL"];
const modelSettings = ["models.prefilter", "models.score", "models.understand", "models.summarize", "models.structure"];
const previousEnvs = new Map([...capabilityEnvs, "EFFECTIVE_TEST_BASE_URL", "EFFECTIVE_TEST_API_KEY", "MODEL_CALLS_ENABLED", "RESEARCH_BACKFILL_ENABLED"].map(key => [key, process.env[key]]));
const previousModelValve = config.modelCallsEnabled;
let settings: Array<{ key: string; value: unknown }> = [];

before(async () => {
  const db = new URL(config.databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) && /_(test|ci)$/.test(db.pathname), "local throwaway DB only");
  settings = await sql`SELECT key,value FROM settings WHERE key=ANY(${modelSettings})`;
  await sql`DELETE FROM settings WHERE key=ANY(${modelSettings})`;
  invalidateModelCache();
  MODELS[modelKey] = { key: modelKey, service: `local-effective-${T}`, model: "fixture-model", baseUrlEnv: "EFFECTIVE_TEST_BASE_URL", apiKeyEnv: "EFFECTIVE_TEST_API_KEY", jsonMode: true };
  for (const key of capabilityEnvs) process.env[key] = modelKey;
  process.env.EFFECTIVE_TEST_BASE_URL = `${provider.url}/v1`;
  process.env.EFFECTIVE_TEST_API_KEY = "test-key";
  process.env.MODEL_CALLS_ENABLED = "true";
  process.env.RESEARCH_BACKFILL_ENABLED = "true";
  config.modelCallsEnabled = true; // Only this loopback fixture model is enabled.
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${sourceId},${sourceId},'rss','T1','editorial','2100-01-01')`;
});
after(async () => {
  for (const hold of holds.values()) hold.release.open();
  await provider.close();
  config.modelCallsEnabled = previousModelValve;
  delete MODELS[modelKey];
  for (const [key, value] of previousEnvs) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE source_id=${sourceId}`;
  await sql`DELETE FROM settings WHERE key=ANY(${modelSettings})`;
  for (const row of settings) await sql`INSERT INTO settings (key,value) VALUES (${row.key},${sql.json(row.value as never)})`;
  invalidateModelCache();
  await stopBoss();
  await closeDb();
});

let serial = 0;
async function article(manual = false) {
  const marker = `EFFECTIVE-${T}-${++serial}`;
  const { articleId: id } = await upsertMaterial({ sourceId, url: `https://example.org/${marker}`, title: `Natural compound drug study ${marker}`, bodyText: abstract, bodyStatus: "ok", bibliography, via: "fetch" });
  await sql`UPDATE articles SET research_abstract=${abstract},research_material_kind='paper-abstract' WHERE id=${id}`;
  if (manual) await overrideFields(id, { fields: { researchBibliography: corrected }, reason: "本地元数据回归样本", version: 0 }, "test-editor");
  return { id, marker };
}
async function stored(id: string) {
  const [row] = await sql`SELECT revision,processing_state,research_profile,research_material_fingerprint,research_processing_version,
    research_retry_at,research_backfill_attempted_at,research_enriched_at FROM articles WHERE id=${id}`;
  return row!;
}
async function assertStale(id: string, result: Awaited<ReturnType<typeof analyzeArticle>>) {
  assert.equal(result?.stale, true, "a changed effective input must not commit");
  const row = await stored(id);
  assert.equal(row.processing_state, "new");
  assert.equal(row.research_profile, null);
  assert.equal(row.research_material_fingerprint, null);
  const [analysis] = await sql`SELECT input_revision,receipt_ids FROM analyses WHERE id=${result!.analysisId!}`;
  assert.equal(analysis!.input_revision, 1, "stale output remains in audit history");
  const receipts = await sql`SELECT status FROM receipts WHERE id=ANY(${analysis!.receipt_ids})`;
  assert.equal(receipts.length, 5);
  assert.ok(receipts.every(r => r.status === "completed"), "completed local responses remain reusable");
}
function holdStructure(marker: string) {
  const hold = { entered: gate(), release: gate() };
  holds.set(marker, hold);
  return hold;
}
async function waitFor(predicate: () => Promise<boolean>, label: string) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test("stable effective bibliography converges, preserves manual fields, and reuses completed responses", async () => {
  const { id } = await article(true);
  await overrideFields(id, { fields: { title: "人工标题", summary: "人工摘要", selected: false }, reason: "保留既有人工字段", version: 1 }, "test-editor");
  const input = (await loadAnalyzeInput(id))!;
  assert.equal(input.bibliography?.journal, corrected.journal);
  const result = await analyzeArticle(id);
  assert.equal(result?.stale, false);
  const row = await stored(id);
  assert.equal(row.processing_state, "analyzed");
  assert.equal(row.research_profile.status, "ready");
  assert.equal(row.research_profile.bibliography.journal, corrected.journal);
  assert.equal(row.research_processing_version, RESEARCH_PROCESSING_VERSION);
  assert.equal(row.research_material_fingerprint, researchMaterialFingerprint(input));
  await publishArticle(id);
  const [publication] = await sql`SELECT title,summary,selected,research FROM publications WHERE article_id=${id}`;
  assert.deepEqual([publication!.title, publication!.summary, publication!.selected], ["人工标题", "人工摘要", false]);
  assert.equal(publication!.research.bibliography.journal, corrected.journal);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(again?.stale, false);
  assert.equal(again?.reused, true);
  assert.deepEqual(again?.receiptIds, result?.receiptIds);
  assert.equal(provider.hits(), hits, "unchanged work must not issue another request");
});

test("missing and legacy non-object bibliography overrides fall back to source metadata", async () => {
  for (const value of [undefined, null, "legacy", []]) {
    const { id } = await article();
    if (value !== undefined) await sql`INSERT INTO editorial_overrides (article_id,fields,reason,version,updated_by) VALUES (${id},${sql.json({ researchBibliography: value })},'legacy fixture',1,'test-editor')`;
    const result = await analyzeArticle(id);
    assert.equal(result?.stale, false);
    const row = await stored(id);
    assert.equal(row.processing_state, "analyzed");
    assert.equal(row.research_profile.bibliography.journal, bibliography.journal);
  }
});

test("an empty object bibliography correction remains the effective empty metadata", async () => {
  const { id } = await article();
  // Legacy object overrides bypass today's complete admin schema, but still have input semantics.
  await sql`INSERT INTO editorial_overrides (article_id,fields,reason,version,updated_by)
    VALUES (${id},${sql.json({ researchBibliography: {} })},'empty object fixture',1,'test-editor')`;
  const input = (await loadAnalyzeInput(id))!;
  assert.deepEqual(input.bibliography, normalizeBibliography({}));
  assert.notDeepEqual(input.bibliography, bibliography, "an object must not fall back to source metadata");
  const result = await analyzeArticle(id);
  assert.equal(result?.stale, false);
  const row = await stored(id);
  assert.equal(row.processing_state, "analyzed");
  assert.deepEqual(row.research_profile.bibliography, input.bibliography);
  assert.equal(row.research_material_fingerprint, researchMaterialFingerprint(input));
});

test("structure without research retains revision-only commits and skips the new metadata query", async () => {
  for (const changeRevision of [false, true]) {
    const { id, marker } = await article(true);
    withoutResearch.add(marker);
    const hold = holdStructure(marker), pending = analyzeArticle(id);
    const previousDebug = sql.options.debug, queries: string[] = [];
    let result: Awaited<ReturnType<typeof analyzeArticle>>;
    try {
      await hold.entered.promise;
      // Material and effective metadata change in both cases; only revision decides this old path.
      await sql`UPDATE articles SET research_abstract=${abstract + " Newly acquired material."},
        revision=revision+${changeRevision ? 1 : 0} WHERE id=${id}`;
      await overrideFields(id, { fields: { researchBibliography: { ...corrected, journal: "Later Correction" } },
        reason: "无研究输出的兼容性样本", version: 1 }, "test-editor");
      sql.options.debug = (_connection, query) => { queries.push(query); };
      hold.release.open();
      result = await pending;
    } finally {
      sql.options.debug = previousDebug;
      hold.release.open();
    }
    assert.equal(result?.stale, changeRevision);
    assert.ok(queries.some(query => /FROM articles WHERE id = .*FOR UPDATE/i.test(query)), "the commit path was observed");
    assert.ok(!queries.some(query => /SELECT CASE WHEN jsonb_typeof\(fields->'researchBibliography'\)/i.test(query)), "no new override query without research output");
    const row = await stored(id);
    assert.equal(row.processing_state, changeRevision ? "new" : "analyzed");
    assert.equal(row.research_profile, null);
    assert.equal(row.research_material_fingerprint, null);
    const [analysis] = await sql`SELECT output,receipt_ids FROM analyses WHERE id=${result!.analysisId!}`;
    assert.equal(analysis!.output.research, null);
    assert.equal(analysis!.receipt_ids.length, 5);
    const receipts = await sql`SELECT status FROM receipts WHERE id=ANY(${analysis!.receipt_ids})`;
    assert.ok(receipts.every(receipt => receipt.status === "completed"));
  }
});

test("a source bibliography change without a correction is stale even at the same revision", async () => {
  const { id, marker } = await article();
  const hold = holdStructure(marker), pending = analyzeArticle(id);
  try {
    await hold.entered.promise;
    await sql`UPDATE articles SET bibliography=${sql.json(corrected)} WHERE id=${id}`;
  } finally { hold.release.open(); }
  await assertStale(id, await pending);
  assert.equal((await stored(id)).revision, 1);
});

test("source bibliography refresh masked by a stable correction leaves effective material unchanged", async () => {
  const { id, marker } = await article(true);
  const hold = holdStructure(marker), pending = analyzeArticle(id);
  try {
    await hold.entered.promise;
    await sql`UPDATE articles SET bibliography=${sql.json({ ...bibliography, journal: "Refreshed Source Journal" })} WHERE id=${id}`;
  } finally { hold.release.open(); }
  assert.equal((await pending)?.stale, false);
  assert.equal((await stored(id)).processing_state, "analyzed");
});

test("same-revision abstract or body refresh cannot be overwritten by older extraction", async () => {
  for (const column of ["research_abstract", "body_text"]) {
    const { id, marker } = await article(true);
    if (column === "body_text") await sql`UPDATE articles SET research_abstract=NULL WHERE id=${id}`;
    const hold = holdStructure(marker), pending = analyzeArticle(id);
    try {
      await hold.entered.promise;
      await sql`UPDATE articles SET ${sql({ [column]: abstract + " Additional material was reported." })} WHERE id=${id}`;
    } finally { hold.release.open(); }
    await assertStale(id, await pending);
    assert.equal((await stored(id)).revision, 1);
    const retry = await analyzeArticle(id);
    assert.equal(retry?.stale, false, "the new input remains eligible and can converge on retry");
    assert.equal((await stored(id)).processing_state, "analyzed");
  }
});

test("adding, changing or clearing a correction during analysis invalidates its older effective input", async () => {
  for (const action of ["add", "change", "clear"]) {
    const { id, marker } = await article(action !== "add");
    const hold = holdStructure(marker), pending = analyzeArticle(id);
    try {
      await hold.entered.promise;
      await overrideFields(id, {
        fields: action === "clear" ? {} : { researchBibliography: { ...corrected, journal: "New Corrected Journal" } },
        clear: action === "clear" ? ["researchBibliography"] : undefined,
        reason: "分析期间更改人工书目", version: action === "add" ? 0 : 1,
      }, "test-editor");
    } finally { hold.release.open(); }
    await assertStale(id, await pending);
  }
});

test("a correction committed while analysis waits for the article lock is read after the wait", async () => {
  for (const clear of [false, true]) {
    // For edit, input agrees with source; for clear, it differs. Both defeat a pre-lock JOIN snapshot.
    const { id, marker } = await article();
    await overrideFields(id, { fields: { researchBibliography: clear ? corrected : bibliography }, reason: "锁等待前书目", version: 0 }, "test-editor");
    const locked = gate<number>(), releaseLock = gate(), hold = holdStructure(marker);
    const blocker = sql.begin(async tx => {
      await tx`SELECT 1 FROM articles WHERE id=${id} FOR UPDATE`;
      const [row] = await tx`SELECT pg_backend_pid() AS pid`;
      locked.open(row!.pid);
      await releaseLock.promise;
    });
    const blockerPid = await locked.promise;
    const pending = analyzeArticle(id);
    let correction: ReturnType<typeof overrideFields> | undefined;
    try {
      await hold.entered.promise;
      hold.release.open();
      await waitFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%FOR UPDATE%'`).length > 0, "analysis waiting for the article lock");
      correction = overrideFields(id, {
        fields: clear ? {} : { researchBibliography: corrected },
        clear: clear ? ["researchBibliography"] : undefined,
        reason: "锁等待期间提交书目修正", version: 1,
      }, "test-editor");
      await waitFor(async () => {
        const [row] = await sql`SELECT fields,version FROM editorial_overrides WHERE article_id=${id}`;
        return row?.version === 2;
      }, "the editorial write committing before its publication waits for the article lock");
    } finally {
      hold.release.open(); releaseLock.open();
      await blocker;
    }
    const [result] = await Promise.all([pending, correction]);
    await assertStale(id, result);
  }
});

async function backfillFixture(manual = false) {
  const fixture = await article(manual);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category)
    VALUES (${fixture.id},1,'rule','pass','回填索引样本','保留可读资料',40,false,'paper')`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${fixture.id}`;
  await publishArticle(fixture.id);
  return fixture;
}
const runBackfill = (id: string) => backfillResearch({ limit: 1, articleIds: [id], enrichMaterial: async () => {} });
const clearBackfillClaim = (id: string) => sql`UPDATE articles SET research_backfill_attempted_at=NULL,research_retry_at=NULL WHERE id=${id}`;
async function backfillReceipt(id: string) {
  const [receipt] = await sql`SELECT id,status FROM receipts WHERE purpose='research_backfill' AND subject=${`article:${id}@1`} ORDER BY id DESC LIMIT 1`;
  return receipt!;
}
async function assertBackfillRejected(id: string, result: Awaited<ReturnType<typeof backfillResearch>>) {
  assert.deepEqual([result.processed, result.failed], [0, 1]);
  const row = await stored(id);
  assert.equal(row.processing_state, "analyzed", "a failed enrichment must keep the index readable");
  assert.equal(row.research_profile, null);
  assert.equal(row.research_material_fingerprint, null);
  assert.ok(row.research_retry_at > new Date(), "retain the existing stale-material retry policy");
  assert.equal((await backfillReceipt(id)).status, "received", "the response remains reusable when commit validation rolls back");
  const [publication] = await sql`SELECT visibility,eligible,research FROM publications WHERE article_id=${id}`;
  assert.deepEqual([publication!.visibility, publication!.eligible], ["public", true]);
  assert.notEqual(publication!.research.status, "ready", "a rejected extraction must not reach the public note");
}

test("backfill commits stable corrected metadata, preserves manual publication and reuses unchanged extraction", async () => {
  const { id } = await backfillFixture(true);
  try {
    await overrideFields(id, { fields: { title: "回填人工标题", summary: "回填人工摘要", selected: false }, reason: "回填保留人工字段", version: 1 }, "test-editor");
    const input = (await loadAnalyzeInput(id))!, beforeHits = provider.hits();
    const [dailyBefore] = await sql`SELECT count(*)::int AS n FROM articles WHERE research_backfill_attempted_at >= now()-interval '24 hours'`;
    const result = await runBackfill(id);
    assert.deepEqual([result.processed, result.failed], [1, 0]);
    assert.equal(result.remainingDailyCapacity, 19 - dailyBefore!.n, "the existing rolling cap remains 20");
    assert.equal(provider.hits(), beforeHits + 1);
    const row = await stored(id);
    assert.equal(row.research_profile.status, "ready");
    assert.equal(row.research_profile.bibliography.journal, corrected.journal);
    assert.equal(row.research_material_fingerprint, researchMaterialFingerprint(input));
    assert.equal(row.research_processing_version, RESEARCH_PROCESSING_VERSION);
    assert.equal(row.research_retry_at, null);
    assert.ok(row.research_backfill_attempted_at && row.research_enriched_at);
    assert.equal((await backfillReceipt(id)).status, "completed");
    const [publication] = await sql`SELECT title,summary,selected,research FROM publications WHERE article_id=${id}`;
    assert.deepEqual([publication!.title, publication!.summary, publication!.selected], ["回填人工标题", "回填人工摘要", false]);
    assert.equal(publication!.research.bibliography.journal, corrected.journal);
    await clearBackfillClaim(id);
    await sql`UPDATE articles SET research_enriched_at=NULL WHERE id=${id}`;
    const hits = provider.hits(), receipt = await backfillReceipt(id);
    const again = await runBackfill(id);
    assert.deepEqual([again.processed, again.failed], [1, 0]);
    assert.equal(provider.hits(), hits, "unchanged extraction is reused without a new model request");
    assert.deepEqual(await backfillReceipt(id), receipt);
  } finally { await clearBackfillClaim(id); }
});

test("backfill treats an empty object correction as effective metadata rather than source fallback", async () => {
  const { id } = await backfillFixture();
  try {
    await sql`INSERT INTO editorial_overrides (article_id,fields,reason,version,updated_by)
      VALUES (${id},${sql.json({ researchBibliography: {} })},'empty backfill fixture',1,'test-editor')`;
    const input = (await loadAnalyzeInput(id))!;
    const result = await runBackfill(id);
    assert.deepEqual([result.processed, result.failed], [1, 0]);
    const row = await stored(id);
    assert.deepEqual(row.research_profile.bibliography, normalizeBibliography({}));
    assert.equal(row.research_material_fingerprint, researchMaterialFingerprint(input));
  } finally { await clearBackfillClaim(id); }
});

test("backfill rejects same-revision abstract and uncorrected source metadata updates", async () => {
  for (const change of ["abstract", "bibliography"]) {
    const { id, marker } = await backfillFixture();
    const hold = holdStructure(marker), pending = runBackfill(id);
    try {
      await hold.entered.promise;
      if (change === "abstract") await sql`UPDATE articles SET research_abstract=${abstract + " Updated material."} WHERE id=${id}`;
      else await sql`UPDATE articles SET bibliography=${sql.json(corrected)} WHERE id=${id}`;
      hold.release.open();
      await assertBackfillRejected(id, await pending);
      assert.equal((await stored(id)).revision, 1);
    } finally { hold.release.open(); await clearBackfillClaim(id); }
  }
});

test("backfill rejects added, changed or cleared corrections and can reuse a received response after restoration", async () => {
  for (const action of ["add", "change", "clear"]) {
    const { id, marker } = await backfillFixture(action !== "add");
    const hold = holdStructure(marker), pending = runBackfill(id);
    try {
      await hold.entered.promise;
      await overrideFields(id, {
        fields: action === "clear" ? {} : { researchBibliography: { ...corrected, journal: "Concurrent Backfill Correction" } },
        clear: action === "clear" ? ["researchBibliography"] : undefined,
        reason: "回填期间修改有效书目", version: action === "add" ? 0 : 1,
      }, "test-editor");
      hold.release.open();
      await assertBackfillRejected(id, await pending);
      const receipt = await backfillReceipt(id), hits = provider.hits();
      await overrideFields(id, {
        fields: action === "add" ? {} : { researchBibliography: corrected },
        clear: action === "add" ? ["researchBibliography"] : undefined,
        reason: "本地样本恢复分析所读材料", version: action === "add" ? 1 : 2,
      }, "test-editor");
      await clearBackfillClaim(id);
      const repaired = await runBackfill(id);
      assert.deepEqual([repaired.processed, repaired.failed], [1, 0]);
      assert.equal(provider.hits(), hits, "restoring the same input reuses the received answer");
      assert.deepEqual(await backfillReceipt(id), { id: receipt.id, status: "completed" });
    } finally { hold.release.open(); await clearBackfillClaim(id); }
  }
});

test("backfill reads corrections committed while waiting for its article commit lock", async () => {
  for (const clear of [false, true]) {
    const { id, marker } = await backfillFixture();
    await overrideFields(id, { fields: { researchBibliography: clear ? corrected : bibliography }, reason: "回填锁等待前书目", version: 0 }, "test-editor");
    const hold = holdStructure(marker), pending = runBackfill(id);
    await hold.entered.promise; // Its daily claim must complete before the test holds the article lock.
    const locked = gate<number>(), releaseLock = gate();
    const blocker = sql.begin(async tx => {
      await tx`SELECT 1 FROM articles WHERE id=${id} FOR UPDATE`;
      const [row] = await tx`SELECT pg_backend_pid() AS pid`;
      locked.open(row!.pid);
      await releaseLock.promise;
    });
    const blockerPid = await locked.promise;
    let correction: ReturnType<typeof overrideFields> | undefined;
    try {
      hold.release.open();
      await waitFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%FOR UPDATE%'`).length > 0, "backfill waiting for its article commit lock");
      correction = overrideFields(id, {
        fields: clear ? {} : { researchBibliography: corrected },
        clear: clear ? ["researchBibliography"] : undefined,
        reason: "回填锁等待期间提交书目修正", version: 1,
      }, "test-editor");
      await waitFor(async () => (await sql`SELECT version FROM editorial_overrides WHERE article_id=${id}`)[0]?.version === 2, "backfill correction committing before publication waits");
    } finally { hold.release.open(); releaseLock.open(); await blocker; }
    try {
      const [result] = await Promise.all([pending, correction]);
      await assertBackfillRejected(id, result);
    } finally { await clearBackfillClaim(id); }
  }
});
