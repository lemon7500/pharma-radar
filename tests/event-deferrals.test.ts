// Only local throwaway DBs and local provider stubs are used; recovery itself never calls a model.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { deferEventJob, importLegacyEventDeferrals, recoverDeferredEventJobs } from "@aihot/backend/jobs/event-deferrals";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { enqueue, ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeStoryDigest } from "@aihot/backend/events/digest";

const T = tag(), SOURCE = `deferrals-${T}`;
const oldEnabled = config.modelCallsEnabled;
const keys: string[] = [], articleIds: string[] = [], storyIds: number[] = [], sourceJobIds: string[] = [];
const budget = () => new BudgetExceededError("deepseek", "day", 3600);

async function article() {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${tag()}`, title: "Recovery sample", bodyText: "material", bodyStatus: "ok", via: "fetch" });
  keys.push(articleId); articleIds.push(articleId);
  return articleId;
}
async function story() {
  const [row] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, 'Deferred sample') RETURNING id`;
  storyIds.push(row!.id); keys.push(`story:${row!.id}`);
  return row!.id;
}
const row = async (key: string) => (await sql<{ payload: unknown; reason: string; service: string | null; next_retry_at: Date; deferral_count: number }[]>`SELECT payload, reason, service, next_retry_at, deferral_count FROM event_job_deferrals WHERE job_key = ${key}`)[0];
const due = (key: string) => sql`UPDATE event_job_deferrals SET next_retry_at = now() - interval '1 minute' WHERE job_key = ${key}`;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  config.modelCallsEnabled = true;
  await sql`INSERT INTO sources (id, name, kind) VALUES (${SOURCE}, 'Deferred event tests', 'rss')`;
  await ensureQueue(QUEUES.group); await ensureQueue(QUEUES.digest);
});
after(async () => {
  config.modelCallsEnabled = oldEnabled;
  await sql`DELETE FROM event_job_deferrals WHERE job_key = ANY(${keys}::text[])`;
  await sql`DELETE FROM event_job_deferral_imports WHERE source_job_id = ANY(${sourceJobIds}::uuid[])`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${articleIds}::text[]) OR data->>'storyId' = ANY(${storyIds.map(String)}::text[])`;
  await stopBoss(); await closeDb();
});

test("safe waits survive job completion and coalesce flags without downgrading corrections", async () => {
  const articleId = await article(), storyId = await story();
  const at = new Date();
  await Promise.all([
    deferEventJob(QUEUES.group, { articleId, signalOnly: true }, new ReceiptBusyError("Receipt 12 is in flight"), { now: at }),
    deferEventJob(QUEUES.group, { articleId, signalOnly: false, force: true }, budget(), { now: at }),
  ]);
  await deferEventJob(QUEUES.group, { articleId, signalOnly: true, force: false }, new ReceiptBusyError("Receipt 12 is in flight"), { now: at });
  const group = await row(articleId);
  assert.deepEqual(group!.payload, { articleId, signalOnly: false, force: true });
  assert.equal(group!.deferral_count, 3);
  assert.equal(group!.reason, "budget"); assert.equal(group!.service, "deepseek");
  assert.equal(group!.next_retry_at.getTime(), at.getTime() + 3600_000, "the shorter busy wait preserves the longer budget wait");
  await deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, budget());
  await deferEventJob(QUEUES.digest, { storyId }, budget());
  assert.deepEqual((await row(`story:${storyId}`))!.payload, { storyId, afterCorrection: true });
});

test("unknown outcomes, model output errors and non-allowlisted payloads never become waits", async () => {
  const articleId = await article();
  await assert.rejects(deferEventJob(QUEUES.group, { articleId }, new ReceiptUnknownError(123, "unknown")), ReceiptUnknownError);
  await assert.rejects(deferEventJob(QUEUES.group, { articleId }, new ModelOutputError("invalid")), ModelOutputError);
  await assert.rejects(deferEventJob(QUEUES.group, { articleId, apiKey: "not-stored" }, budget()), /Invalid deferred/);
  await assert.rejects(deferEventJob(QUEUES.digest, { storyId: "1" }, budget()), /Invalid deferred/);
  assert.equal(await row(articleId), undefined);
});

test("closed budgets retain work and honor the next availability time without paid attempts", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  await deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, budget()); await due(key);
  const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
  const retryAt = new Date(Date.now() + 7200_000);
  await recoverDeferredEventJobs({ budget: async (_service, db) => {
    assert.notEqual(db, sql, "budget read shares the transaction rather than taking another pooled connection");
    return { available: false, retryAt };
  } });
  assert.equal((await row(key))!.next_retry_at.getTime(), retryAt.getTime());
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${QUEUES.digest} AND data->>'storyId' = ${String(storyId)}`).length, 0);
  const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
  assert.equal(after!.n, before!.n);
});

test("competing sweeps enqueue one complete request and consume it only once", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  await deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, budget()); await due(key);
  const results = await Promise.all([recoverDeferredEventJobs(), recoverDeferredEventJobs()]);
  assert.equal(results.reduce((sum, r) => sum + r.enqueued, 0), 1);
  assert.equal(await row(key), undefined);
  const jobs = await sql<{ data: unknown; singleton_key: string }[]>`SELECT data, singleton_key FROM pgboss.job WHERE name = ${QUEUES.digest} AND data->>'storyId' = ${String(storyId)}`;
  assert.deepEqual(jobs.map((j) => j.data), [{ storyId, afterCorrection: true }]);
  assert.equal(jobs[0]!.singleton_key, key);
});

test("short policy conflicts retain the stronger request until the current queued job is consumed", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  const initialId = await enqueue(QUEUES.digest, { storyId }, { singletonKey: key });
  assert.ok(initialId);
  await deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, new ReceiptBusyError("Receipt 3 is in flight")); await due(key);
  assert.ok((await recoverDeferredEventJobs()).retained >= 1);
  assert.deepEqual((await row(key))!.payload, { storyId, afterCorrection: true });
  await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = ${initialId!}`;
  await due(key); assert.ok((await recoverDeferredEventJobs()).enqueued >= 1);
  assert.equal(await row(key), undefined);
  const pending = await sql<{ data: unknown }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUES.digest} AND data->>'storyId' = ${String(storyId)} AND state = 'created'`;
  assert.deepEqual(pending.map((j) => j.data), [{ storyId, afterCorrection: true }]);
});

test("a transaction failure after enqueue rolls back the job and preserves the wait", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  await deferEventJob(QUEUES.digest, { storyId }, budget()); await due(key);
  await sql.unsafe(`CREATE FUNCTION event_deferral_crash_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.job_key = '${key}' THEN RAISE EXCEPTION 'simulated crash after enqueue'; END IF; RETURN OLD; END $$`);
  await sql.unsafe("CREATE TRIGGER event_deferral_crash_test BEFORE DELETE ON event_job_deferrals FOR EACH ROW EXECUTE FUNCTION event_deferral_crash_test()");
  try {
    await assert.rejects(recoverDeferredEventJobs(), /simulated crash/);
    assert.ok(await row(key));
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${QUEUES.digest} AND data->>'storyId' = ${String(storyId)}`).length, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER event_deferral_crash_test ON event_job_deferrals");
    await sql.unsafe("DROP FUNCTION event_deferral_crash_test()");
  }
  assert.ok((await recoverDeferredEventJobs()).enqueued >= 1);
});

async function failed(queue: typeof QUEUES.group | typeof QUEUES.digest, data: object, output: object) {
  const id = await enqueue(queue, data, { retryLimit: 0, singletonKey: randomUUID() });
  assert.ok(id); sourceJobIds.push(id);
  await sql`UPDATE pgboss.job SET state = 'failed', completed_on = now(), output = ${sql.json(output as never)} WHERE id = ${id}`;
  return id;
}

test("legacy budget and busy failures import atomically, with a durable once-only marker and audit", async () => {
  const storyId = await story(), articleId = await article();
  const ids = [
    await failed(QUEUES.digest, { storyId, afterCorrection: true }, { name: "Error", service: "llm", message: "Budget for llm exhausted (day)", retryAfterSeconds: 3600 }),
    await failed(QUEUES.group, { articleId, signalOnly: true, force: true }, { name: "Error", message: "Receipt 43 is in flight" }),
  ];
  const results = await Promise.all([importLegacyEventDeferrals(), importLegacyEventDeferrals()]);
  assert.equal(results.reduce((sum, r) => sum + r.imported, 0), 2);
  assert.deepEqual((await row(`story:${storyId}`))!.payload, { storyId, afterCorrection: true });
  assert.deepEqual((await row(articleId))!.payload, { articleId, signalOnly: true, force: true });
  await recoverDeferredEventJobs();
  assert.equal((await importLegacyEventDeferrals()).imported, 0);
  assert.equal(await row(articleId), undefined); assert.equal(await row(`story:${storyId}`), undefined);
  const markers = await sql`SELECT source_job_id FROM event_job_deferral_imports WHERE source_job_id = ANY(${ids}::uuid[])`;
  assert.equal(markers.length, 2);
  const audit = await sql`SELECT subject FROM audit_log WHERE action = 'event.defer.import' AND subject = ANY(${ids.map((id) => `job:${id}`)}::text[])`;
  assert.equal(audit.length, 2);
});

test("legacy lookalike, unknown and provider-error outputs are not imported", async () => {
  const storyId = await story();
  for (const output of [
    { name: "ReceiptUnknownError", service: "llm", message: "Budget for llm exhausted (day)", retryAfterSeconds: 3600 },
    { name: "Error", service: "llm", message: "Budget for deepseek exhausted (day)", retryAfterSeconds: 3600 },
    { name: "Error", service: "socialdata", message: "Budget for socialdata exhausted (day)", retryAfterSeconds: 3600 },
    { name: "Error", service: "llm", message: "Budget for llm exhausted (day)", retryAfterSeconds: "3600" },
    { name: "Error", message: "Receipt 43 has an unknown outcome; it is released once automatically" },
    { name: "ModelOutputError", message: "Receipt 43 is in flight" },
  ]) await failed(QUEUES.digest, { storyId }, output);
  await failed(QUEUES.digest, { storyId, extra: "disallowed" }, { name: "Error", service: "llm", message: "Budget for llm exhausted (day)", retryAfterSeconds: 3600 });
  assert.equal((await importLegacyEventDeferrals()).imported, 0);
  assert.equal(await row(`story:${storyId}`), undefined);
});

test("recovery honors the model-off valve and never enqueues waiting work", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  await deferEventJob(QUEUES.digest, { storyId }, budget()); await due(key);
  config.modelCallsEnabled = false;
  try { assert.equal((await recoverDeferredEventJobs()).disabled, true); assert.ok(await row(key)); }
  finally { config.modelCallsEnabled = true; }
  await recoverDeferredEventJobs();
});

test("a newer correction written while a sweep owns the key is retained for the following run", async () => {
  const storyId = await story(), key = `story:${storyId}`;
  await deferEventJob(QUEUES.digest, { storyId }, budget()); await due(key);
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sweep = recoverDeferredEventJobs({ budget: async () => { reached(); await held; return { available: true, retryAt: null }; } });
  await entered;
  const correction = deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, budget());
  release(); await Promise.all([sweep, correction]);
  assert.deepEqual((await row(key))!.payload, { storyId, afterCorrection: true });
  assert.ok((await row(key))!.next_retry_at > new Date());
});

test("event digest handler turns budget exhaustion into durable waiting before returning", async () => {
  const articleId = await article(), storyId = await story();
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-pharma', '测试', '测试材料摘要足够长。', 60, false, '{}'::jsonb)`;
  await publishArticle(articleId);
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${randomUUID()}, ${storyId}, 'Test') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
  const handlers = new Map<string, (jobs: Array<{ id: string; data: object }>) => Promise<unknown>>();
  const boss = { work: async (name: string, _options: unknown, handler: (jobs: Array<{ id: string; data: object }>) => Promise<unknown>) => { handlers.set(name, handler); return "registered"; } } as unknown as PgBoss;
  await registerEventJobs(boss);
  const [saved] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'deepseek'`;
  process.env.DEEPSEEK_API_KEY = "test-key"; process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1/v1";
  await sql`UPDATE budgets SET per_day = 0 WHERE service = 'deepseek'`;
  try {
    const result = await handlers.get(QUEUES.digest)!([{ id: randomUUID(), data: { storyId, afterCorrection: true } }]);
    assert.equal((result as { state: string }).state, "waiting");
    assert.deepEqual((await row(`story:${storyId}`))!.payload, { storyId, afterCorrection: true });
  } finally {
    if (saved) await sql`UPDATE budgets SET per_day = ${saved.per_day} WHERE service = 'deepseek'`;
    delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
  }
});

test("unknown, pending and failed event receipts cannot bypass a closed-budget recovery check", async () => {
  for (const status of ["unknown", "pending", "failed"]) {
    const storyId = await story(), key = `story:${storyId}`;
    await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status) VALUES (${`no-replay-${tag()}`}, 'deepseek', 'story_digest', ${`${key}@1`}, ${status})`;
    await deferEventJob(QUEUES.digest, { storyId }, budget()); await due(key);
    await recoverDeferredEventJobs({ budget: async () => ({ available: false, retryAt: new Date(Date.now() + 3600_000) }) });
    assert.ok(await row(key), status);
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${QUEUES.digest} AND data->>'storyId' = ${String(storyId)}`).length, 0, status);
  }
});

test("a completed digest response can be recovered under a stopped budget without another paid attempt", async () => {
  const provider = await stub(() => ({ id: "digest-replay", choices: [{ message: { content: JSON.stringify({ title: "", digest: "这是已保存的研究进展综述，用于验证恢复时免费复用。", latest: "研究进展" }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  const [saved] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
  const savedModel = process.env.DIGEST_MODEL;
  process.env.DEEPSEEK_API_KEY = "test-key"; process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`; process.env.DIGEST_MODEL = "deepseek-flash";
  await sql`UPDATE budgets SET per_minute = 1000000, per_hour = 1000000, per_day = 1000000 WHERE service = 'deepseek'`;
  try {
    const articleId = await article(), storyId = await story(), key = `story:${storyId}`;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${articleId}, 1, 'rule', 'pass', 'ai-pharma', '免费复用测试', '当前资料的研究摘要用于本地测试。', 60, false, '{}'::jsonb)`;
    await publishArticle(articleId);
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${randomUUID()}, ${storyId}, 'Replay test') RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
    assert.equal((await composeStoryDigest(storyId)).updated, true); assert.equal(provider.hits(), 1);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM story_digests WHERE story_id = ${storyId}`;
      await tx`UPDATE stories SET digest = NULL, latest = NULL, version = 0 WHERE id = ${storyId}`;
      await tx`UPDATE budgets SET per_day = 0 WHERE service = 'deepseek'`;
    });
    const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
    await deferEventJob(QUEUES.digest, { storyId, afterCorrection: true }, budget()); await due(key);
    await recoverDeferredEventJobs();
    assert.equal(await row(key), undefined, "settled evidence is eligible even when the budget is stopped");
    const queued = await sql<{ data: { storyId: number; afterCorrection?: boolean } }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUES.digest} AND state = 'created' AND data->>'storyId' = ${String(storyId)}`;
    assert.equal(queued.length, 1);
    assert.equal((await composeStoryDigest(queued[0]!.data.storyId, { afterCorrection: queued[0]!.data.afterCorrection })).updated, true);
    assert.equal(provider.hits(), 1);
    const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts`;
    assert.equal(after!.n, before!.n);
  } finally {
    if (saved) await sql`UPDATE budgets SET per_minute = ${saved.per_minute}, per_hour = ${saved.per_hour}, per_day = ${saved.per_day} WHERE service = 'deepseek'`;
    delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
    if (savedModel === undefined) delete process.env.DIGEST_MODEL; else process.env.DIGEST_MODEL = savedModel;
    await provider.close();
  }
});
