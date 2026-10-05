// Every write is confined to the local throwaway test DB; providers use local stubs only.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { ARTICLE_QUEUES, EVENT_QUEUES, pendingPriorityWork, runWithBudgetWaiting } from "@aihot/backend/jobs/priority";
import { enqueue, ensureQueue, QUEUES, recordRun, stopBoss } from "@aihot/backend/jobs/queue";
import { readServiceBudget } from "@aihot/backend/providers/budget";
import { MODELS, ModelOutputError } from "@aihot/backend/providers/llm";
import { BudgetExceededError, paidRequest, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { publishArticle } from "@aihot/backend/publication/publish";
import { backfillResearch, claimResearchBackfill, releaseResearchBackfillClaim, researchBackfillPaused } from "@aihot/backend/research/backfill";
import { normalizeBibliography } from "@aihot/backend/research/profile";

const T = tag(), SOURCE = `budget-wait-${T}`;
const QUEUE = `budget-wait-${T}`, OTHER_QUEUE = `budget-wait-other-${T}`;
const services: string[] = [], jobs: string[] = [];
let articleNumber = 0;
const body = "We used machine learning and virtual screening for natural products. We tested drug compounds in vitro with cultured cells. Our results showed activity reduced by 25 percent. Further animal and clinical studies are required.";

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${SOURCE},'Budget waiting tests','rss','T1','editorial')`;
});

after(async () => {
  await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE source_id=${SOURCE}`;
  if (jobs.length) await sql`DELETE FROM pgboss.job WHERE id=ANY(${jobs}::uuid[])`;
  await sql`DELETE FROM job_runs WHERE job LIKE ${`budget-wait-${T}%`}`;
  await sql`DELETE FROM receipts WHERE service=ANY(${services}::text[])`;
  await sql`DELETE FROM budgets WHERE service=ANY(${services}::text[])`;
  await stopBoss();
  await closeDb();
});

async function service(perMinute = 1) {
  const name = `budget-wait-${T}-${tag()}`;
  services.push(name);
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${name},${perMinute},100,100)`;
  return name;
}

async function spendOne(service: string) {
  return paidRequest({ service, purpose: "budget_wait_test", identity: { fixture: tag() } }, async () => ({ response: { ok: true } }));
}

async function article() {
  const n = ++articleNumber;
  const bibliography = normalizeBibliography({ doi: `10.1234/${T}-${n}`, journal: "Original journal", publicationTypes: ["Journal Article"] });
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/budget-wait/${T}/${n}`,
    title: `Natural product drug discovery ${T} ${n}`, bodyText: body, bibliography, bodyStatus: "ok", via: "fetch" });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category)
    VALUES(${articleId},1,'rule','pass','药学研究预算测试','可供阅读的研究材料',70,false,'paper')`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  await publishArticle(articleId);
  return articleId;
}

test("successful work keeps its original result", async () => {
  const result = { processed: 2, marker: Symbol("result") };
  assert.equal(await runWithBudgetWaiting(async () => result), result);
});

test("a real exhausted budget records waiting and allows subsequent free maintenance", async () => {
  const name = await service();
  await spendOne(name);
  const expected = await readServiceBudget(name);
  let paidCalls = 0;
  const budgetJob = `budget-wait-${T}-paid`, maintenanceJob = `budget-wait-${T}-maintenance`;
  const result = await recordRun(budgetJob, () => runWithBudgetWaiting(() => paidRequest(
    { service: name, purpose: "budget_wait_test", identity: { fixture: tag() } },
    async () => { paidCalls++; return { response: {} }; },
  )));
  await recordRun(maintenanceJob, async () => {
    await sql`UPDATE sources SET name='Free maintenance completed' WHERE id=${SOURCE}`;
    return { maintained: true };
  });
  assert.deepEqual(result, { waiting: true, reason: "budget", retryAt: expected.retryAt });
  assert.equal(paidCalls, 0, "the deferred call must not reach its provider");
  assert.ok(expected.retryAt! > new Date());
  const runs = await sql<{ job: string; status: string; detail: { waiting?: boolean; maintained?: boolean } }[]>`
    SELECT job,status,detail FROM job_runs WHERE job IN (${budgetJob},${maintenanceJob}) ORDER BY id`;
  assert.deepEqual(runs.map(row => [row.job, row.status]), [[budgetJob, "ok"], [maintenanceJob, "ok"]]);
  assert.equal(runs[0]!.detail.waiting, true);
  assert.equal(runs[1]!.detail.maintained, true);
  assert.equal((await sql`SELECT name FROM sources WHERE id=${SOURCE}`)[0]!.name, "Free maintenance completed");
});

test("an operator-stopped service has no invented reopening time", async () => {
  const name = await service(0);
  const result = await runWithBudgetWaiting(async () => { throw new BudgetExceededError(name, "stopped", 3600); });
  assert.deepEqual(result, { waiting: true, reason: "budget", retryAt: null });
});

test("an in-flight receipt is a bounded wait", async () => {
  const before = Date.now();
  const result = await runWithBudgetWaiting(async () => { throw new ReceiptBusyError("Receipt is in flight"); });
  assert.ok("waiting" in result && result.waiting);
  assert.equal(result.reason, "receipt-busy");
  assert.ok(result.retryAt!.getTime() >= before + 60_000);
  assert.ok(result.retryAt!.getTime() <= Date.now() + 60_000);
});

test("provider rejection, unusable output, unknown outcomes and lookalike messages still throw", async () => {
  const errors = [
    new ProviderRejectedError("provider returned HTTP 503", 503, true),
    new ModelOutputError("model returned unusable JSON"),
    new ReceiptUnknownError(123, "request outcome is unknown"),
    new Error("Budget for deepseek exhausted (day)"),
    new Error("Receipt 123 is in flight"),
  ];
  for (const error of errors) await assert.rejects(runWithBudgetWaiting(async () => { throw error; }), thrown => thrown === error);
});

test("priority waits include active work and ready retries through the 90-second boundary only", async () => {
  assert.deepEqual(ARTICLE_QUEUES, [QUEUES.fetchSource, QUEUES.fetchXShard, QUEUES.mpCheck, QUEUES.extractBody, QUEUES.analyze, QUEUES.republishSource]);
  assert.deepEqual(EVENT_QUEUES, [QUEUES.group, QUEUES.digest]);
  await ensureQueue(QUEUE, { policy: "standard" });
  await ensureQueue(OTHER_QUEUE, { policy: "standard" });
  const fixtures = [
    { queue: QUEUE, state: "created", seconds: -1 },
    { queue: QUEUE, state: "created", seconds: 90 },
    { queue: QUEUE, state: "retry", seconds: 90 },
    { queue: QUEUE, state: "active", seconds: 3600 },
    { queue: QUEUE, state: "created", seconds: 91 },
    { queue: QUEUE, state: "retry", seconds: 91 },
    ...["completed", "cancelled", "failed"].map(state => ({ queue: QUEUE, state, seconds: -1 })),
    { queue: OTHER_QUEUE, state: "created", seconds: -1 },
  ];
  const ids: string[] = [];
  for (const fixture of fixtures) {
    const id = await enqueue(fixture.queue, { fixture: T });
    assert.ok(id);
    ids.push(id); jobs.push(id);
  }
  await sql.begin(async tx => {
    for (const [index, fixture] of fixtures.entries()) {
      await tx`UPDATE pgboss.job SET state=${fixture.state}::pgboss.job_state,start_after=now()+${fixture.seconds}*interval '1 second'
        WHERE id=${ids[index]!}`;
    }
    assert.equal(await pendingPriorityWork([QUEUE], tx), 4);
    assert.equal(await pendingPriorityWork([OTHER_QUEUE], tx), 1);
    assert.equal(await pendingPriorityWork([QUEUE, OTHER_QUEUE], tx), 5);
    assert.equal(await pendingPriorityWork([], tx), 0);
  });
});

test("a near-due unqueued article preserves article priority without blocking event-only waits", async () => {
  await ensureQueue(QUEUES.analyze);
  const id = await article();
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${id}`).length, 0,
    "this article has no queue job to keep the article stage open");
  await sql.begin(async tx => {
    // Other test files can leave new articles behind; compare only this fixture's contribution.
    const beforeArticles = await pendingPriorityWork(ARTICLE_QUEUES, tx);
    const beforeEvents = await pendingPriorityWork(EVENT_QUEUES, tx);
    await tx`UPDATE articles SET processing_state='new',created_at=now()-interval '4 minutes',
      processing_queued_at=NULL,processing_retry_at=now()+interval '60 seconds' WHERE id=${id}`;
    assert.equal(await pendingPriorityWork(ARTICLE_QUEUES, tx), beforeArticles + 1,
      "a retry due in one minute blocks article drain even without a pg-boss job");
    assert.equal(await pendingPriorityWork(EVENT_QUEUES, tx), beforeEvents,
      "event-only waits must not count article retry bookkeeping");
    await tx`UPDATE articles SET created_at=now() WHERE id=${id}`;
    assert.equal(await pendingPriorityWork(ARTICLE_QUEUES, tx), beforeArticles + 1,
      "a newly collected article already waiting to retry must keep priority before the three-minute safety-net age");
    await tx`UPDATE articles SET processing_retry_at=now()+interval '2 hours' WHERE id=${id}`;
    assert.equal(await pendingPriorityWork(ARTICLE_QUEUES, tx), beforeArticles,
      "a distant retry stays durable without holding this finite run open");
    await tx`UPDATE articles SET processing_state='analyzed',processing_retry_at=NULL WHERE id=${id}`;
  });
});

test("a backfill claim releases its exact database timestamp and saves the retry time", async () => {
  const id = await article();
  assert.equal(await claimResearchBackfill(id), true);
  const [claim] = await sql<{ at: Date }[]>`SELECT research_backfill_attempted_at AS at FROM articles WHERE id=${id}`;
  const retryAt = new Date(Date.now() + 3600_000);
  assert.equal(await releaseResearchBackfillClaim(id, claim!.at, retryAt), true);
  const [row] = await sql`SELECT research_backfill_attempted_at,research_retry_at FROM articles WHERE id=${id}`;
  assert.equal(row!.research_backfill_attempted_at, null);
  assert.equal(row!.research_retry_at.getTime(), retryAt.getTime());
  assert.equal(await releaseResearchBackfillClaim(id, claim!.at, new Date(retryAt.getTime() + 1000)), false);
  assert.equal((await sql`SELECT research_retry_at FROM articles WHERE id=${id}`)[0]!.research_retry_at.getTime(), retryAt.getTime());
});

test("releasing an old claim preserves a later reservation and its retry schedule", async () => {
  const id = await article();
  assert.equal(await claimResearchBackfill(id), true);
  const [claim] = await sql<{ at: Date }[]>`SELECT research_backfill_attempted_at AS at FROM articles WHERE id=${id}`;
  const later = new Date(claim!.at.getTime() + 1000), retryAt = new Date(Date.now() + 7200_000);
  await sql`UPDATE articles SET research_backfill_attempted_at=${later},research_retry_at=${retryAt} WHERE id=${id}`;
  try {
    assert.equal(await releaseResearchBackfillClaim(id, claim!.at, new Date(Date.now() + 60_000)), false);
    const [row] = await sql`SELECT research_backfill_attempted_at,research_retry_at FROM articles WHERE id=${id}`;
    assert.equal(row!.research_backfill_attempted_at.getTime(), later.getTime());
    assert.equal(row!.research_retry_at.getTime(), retryAt.getTime());
  } finally { await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE id=${id}`; }
});

async function withBackfillProvider(run: (provider: Awaited<ReturnType<typeof stub>>, name: string) => Promise<void>) {
  const name = await service(100), model = `budget-wait-model-${tag()}`;
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ research: { areas: [], foci: [], evidenceStages: [], claims: {} } }) }, finish_reason: "stop" }] }));
  const environment = ["RESEARCH_BACKFILL_ENABLED", "MODEL_CALLS_ENABLED", "STRUCTURE_MODEL", "BUDGET_WAIT_TEST_BASE_URL", "BUDGET_WAIT_TEST_API_KEY"];
  const savedEnv = Object.fromEntries(environment.map(key => [key, process.env[key]]));
  const enabled = config.modelCallsEnabled;
  const keys = ["models.structure", "research.backfill.paused"];
  const settings = await sql<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`SELECT key,value,updated_at FROM settings WHERE key=ANY(${keys}::text[])`;
  MODELS[model] = { key: model, service: name, model: "local-test-model", baseUrlEnv: "BUDGET_WAIT_TEST_BASE_URL", apiKeyEnv: "BUDGET_WAIT_TEST_API_KEY", jsonMode: true };
  try {
    Object.assign(process.env, { RESEARCH_BACKFILL_ENABLED: "true", MODEL_CALLS_ENABLED: "true", STRUCTURE_MODEL: model,
      BUDGET_WAIT_TEST_BASE_URL: provider.url, BUDGET_WAIT_TEST_API_KEY: "local-test-only" });
    config.modelCallsEnabled = true;
    await sql`DELETE FROM settings WHERE key=ANY(${keys}::text[])`;
    invalidateModelCache();
    await run(provider, name);
  } finally {
    config.modelCallsEnabled = enabled;
    for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await sql`DELETE FROM settings WHERE key=ANY(${keys}::text[])`;
    for (const row of settings) await sql`INSERT INTO settings(key,value,updated_at) VALUES(${row.key},${sql.json(row.value as never)},${row.updated_at})`;
    delete MODELS[model];
    invalidateModelCache();
    await provider.close();
  }
}

test("budget-deferred backfill keeps free material updates readable without failure or daily-cap consumption", async () => {
  const id = await article();
  await withBackfillProvider(async (provider, name) => {
    await sql`UPDATE budgets SET per_minute=1 WHERE service=${name}`;
    await spendOne(name);
    const expected = await readServiceBudget(name);
    const usedBefore = (await sql`SELECT count(*)::int AS n FROM articles WHERE research_backfill_attempted_at>=now()-interval '24 hours'`)[0]!.n;
    assert.ok(usedBefore < 20, "this fixture must have room to reach the model budget check");
    let refreshed = 0;
    const result = await backfillResearch({ limit: 1, articleIds: [id], enrichMaterial: async articleId => {
      refreshed++;
      await sql`UPDATE articles SET bibliography=jsonb_set(bibliography,'{journal}','"Refreshed journal"') WHERE id=${articleId}`;
    } });
    assert.equal(refreshed, 1);
    assert.equal(result.processed, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.waiting, true);
    assert.equal(result.deferred, 1);
    assert.equal(result.remainingDailyCapacity, 20 - usedBefore);
    assert.equal(provider.hits(), 0);
    assert.equal(await researchBackfillPaused(), false);
    const [row] = await sql`SELECT research_backfill_attempted_at,research_retry_at FROM articles WHERE id=${id}`;
    assert.equal(row!.research_backfill_attempted_at, null);
    assert.equal(row!.research_retry_at.getTime(), expected.retryAt!.getTime());
    const [publication] = await sql`SELECT visibility,eligible,research FROM publications WHERE article_id=${id}`;
    assert.equal(publication!.visibility, "public");
    assert.equal(publication!.eligible, true);
    assert.equal(publication!.research.bibliography.journal, "Refreshed journal");
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service=${name}`)[0]!.n, 1);
  });
});

test("backfill reuses a completed receipt even after its provider budget is stopped", async () => {
  const id = await article();
  await withBackfillProvider(async (provider, name) => {
    const options = { limit: 1, articleIds: [id], enrichMaterial: async () => {} };
    const first = await backfillResearch(options);
    assert.equal(first.processed, 1);
    assert.equal(provider.hits(), 1);
    await sql`UPDATE budgets SET per_minute=0 WHERE service=${name}`;
    // Require extraction again with identical material: its durable receipt remains reusable.
    await sql`UPDATE articles SET research_backfill_attempted_at=NULL,research_enriched_at=NULL,
      research_processing_version=NULL,research_profile=NULL WHERE id=${id}`;
    const second = await backfillResearch(options);
    assert.equal(second.processed, 1);
    assert.equal(second.failed, 0);
    assert.equal(second.waiting, false);
    assert.equal(second.deferred, 0);
    assert.equal(provider.hits(), 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service=${name}`)[0]!.n, 1);
    await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE id=${id}`;
  });
});
