// Reserves are tested with disposable service caps and in-memory responses, never external models.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { applyRequestReserve, budgetSnapshot, classifyRequestWorkload, readRequestReserve, readServiceBudget } from "@aihot/backend/providers/budget";
import { BackgroundReserveExceededError, BudgetExceededError, completeReceipt, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { pendingPriorityWork, pendingRecentPriorityWork, ARTICLE_QUEUES, runWithBudgetWaiting } from "@aihot/backend/jobs/priority";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), SOURCE = `request-reserve-${T}`;
const services: string[] = [], jobs: string[] = [], articles: string[] = [];
let savedSetting: Record<string, unknown> | undefined;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  const [setting] = await sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'processing.request-reserve'`;
  savedSetting = setting?.value;
  await sql`INSERT INTO settings (key, value) VALUES ('processing.request-reserve', '{"enabled":true,"perHour":40,"perDay":200}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO sources (id, name, kind, participation_mode) VALUES (${SOURCE}, 'Request reserve fixture', 'rss', 'editorial')`;
});
after(async () => {
  if (savedSetting) await sql`UPDATE settings SET value = ${sql.json(savedSetting as never)} WHERE key = 'processing.request-reserve'`;
  else await sql`DELETE FROM settings WHERE key = 'processing.request-reserve'`;
  if (jobs.length) await sql`DELETE FROM pgboss.job WHERE id = ANY(${jobs}::uuid[])`;
  await sql`DELETE FROM receipts WHERE service = ANY(${services}::text[])`;
  await sql`DELETE FROM budgets WHERE service = ANY(${services}::text[])`;
  await stopBoss(); await closeDb();
});

async function service(day = 10, hour = 10000, minute = 10000) {
  const name = `reserve-${T}-${tag()}`; services.push(name);
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${name}, ${minute}, ${hour}, ${day})`;
  return name;
}
async function article(ageHours: number | null = 1) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/reserve/${tag()}`, title: "Research fixture", bodyText: "Research abstract", bodyStatus: "ok", via: "fetch",
    publishedAt: ageHours === null ? undefined : new Date(Date.now() - ageHours * 3600_000) });
  articles.push(articleId);
  await sql`UPDATE articles SET processing_state = 'skipped' WHERE id = ${articleId}`;
  return articleId;
}
const request = (service: string, articleId?: string) => ({ service, purpose: articleId ? "structure_article" : "story_digest", subject: articleId ? `article:${articleId}@1` : "story:1@1", ...(articleId ? { attemptTag: "structure" } : {}), identity: { test: tag() } });
const spend = (req: ReturnType<typeof request>) => paidRequest(req, async () => ({ response: { accepted: true } }));

test("configured reserves stay inside every cap and current background allowance cannot exceed total remainder", () => {
  const now = new Date(), limits = { per_minute: 20, per_hour: 200, per_day: 500 };
  const base = budgetSnapshot(limits, Array.from({ length: 450 }, () => new Date(now.getTime() - 120000)), now);
  const result = applyRequestReserve(base, limits, [], now, { enabled: true, tracking: true, perHour: 40, perDay: 200 });
  assert.deepEqual(result.reserve!.reserved, { minute: 0, hour: 40, day: 200 });
  assert.deepEqual(result.reserve!.backgroundCaps, { minute: 20, hour: 160, day: 300 });
  assert.equal(result.reserve!.remainingBackground.day, 50);
  const small = applyRequestReserve(budgetSnapshot({ per_minute: 1, per_hour: 3, per_day: 1 }, [], now), { per_minute: 1, per_hour: 3, per_day: 1 }, [], now,
    { enabled: true, tracking: true, perHour: 40, perDay: 200 });
  assert.deepEqual(small.reserve!.reserved, { minute: 0, hour: 1, day: 0 });
  assert.deepEqual(small.reserve!.backgroundCaps, { minute: 1, hour: 2, day: 1 });
});

test("only current automatic main-chain requests with trusted nonfuture 48h publication dates qualify", async () => {
  const fresh = await article(), old = await article(49), unknown = await article(null), future = await article();
  await sql`UPDATE articles SET published_at = now() + interval '1 minute' WHERE id = ${future}`;
  for (const [purpose, attemptTag] of [["prefilter_article", undefined], ["score_article", "score-1"], ["score_article", "score-2"],
    ["understand_article", "understand"], ["summarize_article", "summarize"], ["structure_article", "structure"]]) {
    assert.equal(await classifyRequestWorkload({ purpose: purpose!, subject: `article:${fresh}@1`, attemptTag }), "recent", `${purpose}/${attemptTag}`);
  }
  for (const req of [
    { purpose: "score_article", subject: `article:${old}@1`, attemptTag: "score-1" },
    { purpose: "score_article", subject: `article:${unknown}@1`, attemptTag: "score-1" },
    { purpose: "score_article", subject: `article:${future}@1`, attemptTag: "score-1" },
    { purpose: "score_article", subject: `article:${fresh}@2`, attemptTag: "score-1" },
    { purpose: "score_article", subject: `article:${fresh}@1`, attemptTag: "" },
    { purpose: "score_article", subject: `article:${fresh}@1`, attemptTag: "manual-test:score-1" },
    { purpose: "structure_article", subject: `article:${fresh}@1`, attemptTag: "manual-test:structure" },
    { purpose: "score_article", subject: `article:${fresh}@1`, attemptTag: "structure" },
    { purpose: "prefilter_article", subject: `article:${fresh}@1`, attemptTag: "prefilter" },
    { purpose: "research_backfill", subject: `article:${fresh}@1` },
    { purpose: "group_article", subject: `article:${fresh}@1` },
    { purpose: "score_article", subject: `article:${fresh}` },
    { purpose: "model_evaluation", subject: `article:${fresh}@1` },
  ]) assert.equal(await classifyRequestWorkload(req), "background", JSON.stringify(req));
  await sql.begin(async tx => {
    const req = { purpose: "structure_article", subject: `article:${fresh}@1`, attemptTag: "structure" };
    await tx`UPDATE articles SET published_at = now() - interval '48 hours' WHERE id = ${fresh}`;
    assert.equal(await classifyRequestWorkload(req, tx), "recent", "48h lower boundary is inclusive at the DB clock");
    await tx`UPDATE articles SET published_at = now() - interval '48 hours 1 second' WHERE id = ${fresh}`;
    assert.equal(await classifyRequestWorkload(req, tx), "background");
    await tx`UPDATE articles SET published_at = now() WHERE id = ${fresh}`;
    assert.equal(await classifyRequestWorkload(req, tx), "recent");
    await tx`UPDATE sources SET participation_mode = 'hot_signal' WHERE id = ${SOURCE}`;
    assert.equal(await classifyRequestWorkload(req, tx), "background", "discussion source cannot claim the editorial reserve");
    throw new Error("rollback classification fixture");
  }).catch(error => { assert.match(String(error), /rollback classification fixture/); });
});

test("concurrent background work cannot cross its cap, leaving existing total allowance for recent research", async () => {
  const name = await service(), fresh = await article();
  let calls = 0;
  const background = await Promise.allSettled(Array.from({ length: 12 }, () => paidRequest(request(name), async () => { calls++; return { response: {} }; })));
  assert.equal(background.filter(r => r.status === "fulfilled").length, 5);
  for (const result of background) if (result.status === "rejected") assert.ok(result.reason instanceof BackgroundReserveExceededError);
  const before = await readServiceBudget(name);
  assert.equal(before.available, false); assert.equal(before.blockedReason, "background-reserve");
  assert.equal(before.remaining!.day, 5); assert.equal(before.reserve!.remainingBackground.day, 0);
  const recent = await Promise.allSettled(Array.from({ length: 12 }, () => paidRequest(request(name, fresh), async () => { calls++; return { response: {} }; })));
  assert.equal(recent.filter(r => r.status === "fulfilled").length, 5);
  assert.equal(calls, 10);
  for (const result of recent) if (result.status === "rejected") {
    assert.ok(result.reason instanceof BudgetExceededError); assert.ok(!(result.reason instanceof BackgroundReserveExceededError));
  }
  const attempts = await sql<{ workload_class: string; n: number }[]>`SELECT workload_class, count(*)::int AS n FROM receipt_attempts WHERE service = ${name} GROUP BY workload_class ORDER BY workload_class`;
  assert.deepEqual(attempts.map(a => [a.workload_class, a.n]), [["background", 5], ["recent", 5]]);
});

test("simultaneous classes remain under the original total cap as well as the background cap", async () => {
  const name = await service(12), fresh = await article();
  const responses = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => spend(request(name, i % 2 ? fresh : undefined))));
  assert.equal(responses.filter(r => r.status === "fulfilled").length, 12);
  const [counts] = await sql<{ n: number; background: number }[]>`SELECT count(*)::int AS n, count(*) FILTER (WHERE workload_class = 'background')::int AS background FROM receipt_attempts WHERE service = ${name}`;
  assert.equal(counts!.n, 12); assert.ok(counts!.background <= 6);
});

test("completed and received responses replay before budget/classification checks and record no new attempts", async () => {
  const name = await service(4), fresh = await article(), first = request(name, fresh), second = request(name, fresh);
  const a = await spend(first), b = await spend(second); await completeReceipt(sql, a.receiptId);
  await sql`UPDATE articles SET published_at = now() - interval '1 year', revision = 2 WHERE id = ${fresh}`;
  await sql`UPDATE budgets SET per_day = 0 WHERE service = ${name}`;
  let callbacks = 0;
  assert.equal((await paidRequest(first, async () => { callbacks++; return { response: null }; })).reused, true);
  assert.equal((await paidRequest(second, async () => { callbacks++; return { response: null }; })).reused, true);
  assert.equal(callbacks, 0);
  const rows = await sql<{ workload_class: string }[]>`SELECT workload_class FROM receipt_attempts WHERE service = ${name}`;
  assert.deepEqual(rows.map(r => r.workload_class), ["recent", "recent"]);
  assert.equal(b.reused, false);
});

test("workload classes remain immutable while usage/status updates and old-style inserts remain compatible", async () => {
  const name = await service(), result = await spend(request(name));
  await assert.rejects(sql`UPDATE receipt_attempts SET workload_class = 'recent' WHERE receipt_id = ${result.receiptId}`, /immutable/);
  await sql`UPDATE receipt_attempts SET latency_ms = 123 WHERE receipt_id = ${result.receiptId}`;
  assert.equal((await sql`SELECT workload_class FROM receipt_attempts WHERE receipt_id = ${result.receiptId}`)[0]!.workload_class, "background");
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status) VALUES (${result.receiptId}, 2, ${name}, 'failed')`;
  assert.equal((await sql`SELECT workload_class FROM receipt_attempts WHERE receipt_id = ${result.receiptId} AND attempt = 2`)[0]!.workload_class, "background");
});

test("reserve waiting uses actual background release time and remains a successful waiting result", async () => {
  const name = await service(100, 4);
  await spend(request(name)); await spend(request(name));
  await sql`UPDATE receipt_attempts SET started_at = now() - interval '50 minutes' WHERE service = ${name}`;
  const expected = await readServiceBudget(name);
  assert.equal(expected.reserve!.blockedWindow, "hour");
  assert.ok(expected.retryAt!.getTime() - Date.now() < 11 * 60_000);
  const result = await runWithBudgetWaiting(() => spend(request(name)));
  assert.deepEqual(result, { waiting: true, reason: "background-reserve", retryAt: expected.retryAt });
  assert.equal((await sql`SELECT id FROM receipt_attempts WHERE service = ${name}`).length, 2);
});

test("an unknown response stays unknown rather than being retried through reserved recent allowance", async () => {
  const name = await service(), fresh = await article(), req = request(name, fresh);
  let calls = 0;
  await assert.rejects(paidRequest(req, async () => { calls++; throw new Error("local callback result unknown"); }));
  await sql`UPDATE budgets SET per_day = 0 WHERE service = ${name}`;
  await assert.rejects(paidRequest(req, async () => { calls++; return { response: {} }; }), ReceiptUnknownError);
  assert.equal(calls, 1);
});

test("missing reserve settings or pre-migration schema keep the original advisory total-budget shape", async () => {
  const name = await service(4);
  await sql.begin(async tx => {
    await tx`DELETE FROM settings WHERE key = 'processing.request-reserve'`;
    assert.equal((await readRequestReserve(tx)).enabled, false);
    assert.equal((await readServiceBudget(name, tx)).reserve, undefined);
    await tx`CREATE TEMP TABLE receipt_attempts (id bigint, service text, origin text, started_at timestamptz) ON COMMIT DROP`;
    await tx`INSERT INTO settings (key, value) VALUES ('processing.request-reserve', '{"enabled":true}')`;
    const before = await readRequestReserve(tx);
    assert.equal(before.tracking, false); assert.equal(before.enabled, false);
    assert.deepEqual(await readServiceBudget(name, tx), { available: true, blockedWindow: null, retryAt: null, remaining: { minute: 10000, hour: 10000, day: 4 } });
    // Roll back settings changes as well as the temporary compatibility fixture.
    throw new Error("rollback compatibility fixture");
  }).catch(error => { assert.match(String(error), /rollback compatibility fixture/); });
  const noBudget = `reserve-no-budget-${T}`; services.push(noBudget);
  assert.deepEqual(await readServiceBudget(noBudget), { available: true, blockedWindow: null, retryAt: null, remaining: null });
});

test("recent phase ignores historical first analyses and delayed jobs while total priority stays compatible", async () => {
  const old = await article(100), fresh = await article(), future = await article();
  for (const [id, delay] of [[old, 0], [future, 3600]] as const) {
    const job = await enqueue(QUEUES.analyze, { articleId: id }, { singletonKey: id, startAfter: delay });
    jobs.push(job!); await sql`UPDATE articles SET processing_queued_at = now() WHERE id = ${id}`;
  }
  const before = await pendingRecentPriorityWork(ARTICLE_QUEUES);
  const total = await pendingPriorityWork(ARTICLE_QUEUES);
  assert.ok(total >= 1, "historical analysis is still durable pending work");
  const job = await enqueue(QUEUES.analyze, { articleId: fresh }, { singletonKey: fresh }); jobs.push(job!);
  await sql`UPDATE articles SET processing_queued_at = now() WHERE id = ${fresh}`;
  assert.equal(await pendingRecentPriorityWork(ARTICLE_QUEUES), before + 1);
  await sql`UPDATE pgboss.job SET state = 'completed' WHERE id = ${job!}`;
  const sourceJob = await enqueue(QUEUES.fetchSource, { sourceId: SOURCE }, { singletonKey: SOURCE, startAfter: 3600 }); jobs.push(sourceJob!);
  assert.equal(await pendingRecentPriorityWork(ARTICLE_QUEUES), before);
  await sql`UPDATE pgboss.job SET start_after = now() - interval '1 minute' WHERE id = ${sourceJob!}`;
  assert.equal(await pendingRecentPriorityWork(ARTICLE_QUEUES), before + 1);
});
