// Queue ordering only: disposable local DB, no model requests or external fetches.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PgBoss } from "pg-boss";
import { closeDb, sql } from "@aihot/backend/db";
import { isHistorical, upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing, refreshProcessingPriorities, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), SOURCE = `processing-priority-${T}`;
const originalQueues = { analyze: QUEUES.analyze, extractBody: QUEUES.extractBody };
const analyzeQueue = `test.processing-priority-${T}`, extractQueue = `test.processing-extract-${T}`;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  Object.assign(QUEUES, { analyze: analyzeQueue, extractBody: extractQueue });
  const boss = await getBoss();
  await boss.createQueue(analyzeQueue, { policy: "short" });
  await boss.createQueue(extractQueue, { policy: "short" });
  await sql`INSERT INTO sources (id,name,kind,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'Processing priority fixture','rss','editorial','2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM pgboss.job WHERE name IN (${analyzeQueue},${extractQueue})`;
  Object.assign(QUEUES, originalQueues);
  await stopBoss(); await closeDb();
});

async function article(ageHours: number | null = 1) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/processing-priority/${tag()}`,
    title: 'Processing priority fixture', bodyText: 'Existing verified body', bodyStatus: 'ok', via: 'fetch',
    publishedAt: ageHours === null ? undefined : new Date(Date.now() - ageHours * 3600_000) });
  // Tests explicitly enqueue; the global sweep must not process fixture articles left by other cases.
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${articleId}`;
  return articleId;
}
async function enqueue(id: string, options: { step?: 'extract' | 'analyze'; attemptTag?: string } = {}) {
  const job = await queueProcessing(id, options); assert.ok(job); return job;
}
async function priority(job: string) { return (await sql`SELECT priority FROM pgboss.job WHERE id=${job}`)[0]!.priority; }

test('automatic current 48h articles lead history, unknown dates, future dates and explicit manual requests', async () => {
  const fresh = await article(), old = await article(72), unknown = await article(null), future = await article(-0.5);
  assert.equal(await priority(await enqueue(fresh)), 2);
  assert.equal(await priority(await enqueue(old)), -2);
  assert.equal(await priority(await enqueue(unknown)), 0);
  assert.equal(await priority(await enqueue(future)), 0);
  assert.equal(await priority(await enqueue(fresh, { attemptTag: `manual-${T}` })), 0);
  assert.equal(await priority(await enqueue(fresh, { step: 'extract' })), 2);
  assert.equal(await priority(await enqueue(fresh, { step: 'extract', attemptTag: `manual-${T}` })), 0);
});

test('an article promptly discovered days ago loses recent priority without changing historical event semantics', async () => {
  const aged = await article(), agedJob = await enqueue(aged);
  assert.equal(await priority(agedJob), 2);
  await sql`UPDATE articles SET published_at=now()-interval '72 hours', discovered_at=now()-interval '71 hours'
    WHERE id=${aged}`;
  const [dates] = await sql<{ backfill: boolean; published_at: Date; discovered_at: Date }[]>`
    SELECT backfill,published_at,discovered_at FROM articles WHERE id=${aged}`;
  assert.equal(isHistorical(dates!), false, 'event history still uses the original discovery relationship');
  const fresh = await article(), freshJob = await enqueue(fresh);
  await refreshProcessingPriorities();
  assert.equal(await priority(agedJob), 0);
  const ordered = await sql<{ id: string }[]>`SELECT id FROM pgboss.job WHERE id IN (${agedJob},${freshJob}) ORDER BY priority DESC,created_on`;
  assert.deepEqual(ordered.map(row => row.id), [freshJob,agedJob], 'the previously queued aged job cannot stand ahead of current research');
});

test('priority refresh updates created and retry jobs while running and manual jobs retain their priorities', async () => {
  const created = await enqueue(await article()), retry = await enqueue(await article(), { step: 'extract' });
  const active = await enqueue(await article()), manual = await enqueue(await article(), { attemptTag: 'explicit-review' });
  const unknown = await enqueue(await article(null)), future = await enqueue(await article(-0.5));
  await sql`UPDATE pgboss.job SET priority=9 WHERE id IN (${created},${retry},${active},${manual},${unknown},${future})`;
  await sql`UPDATE pgboss.job SET state='retry' WHERE id=${retry}`;
  await sql`UPDATE pgboss.job SET state='active' WHERE id=${active}`;
  await refreshProcessingPriorities();
  assert.equal(await priority(created), 2); assert.equal(await priority(retry), 2);
  assert.equal(await priority(active), 9); assert.equal(await priority(manual), 9);
  assert.equal(await priority(unknown), 0); assert.equal(await priority(future), 0);
});

test('priority refresh skips a row already locked by another claim rather than waiting or rewriting it', async () => {
  const job = await enqueue(await article());
  await sql`UPDATE pgboss.job SET priority=9 WHERE id=${job}`;
  await sql.begin(async tx => {
    await tx`SELECT id FROM pgboss.job WHERE id=${job} FOR UPDATE`;
    await refreshProcessingPriorities();
    assert.equal((await tx`SELECT priority FROM pgboss.job WHERE id=${job}`)[0]!.priority, 9);
  });
  await refreshProcessingPriorities(); assert.equal(await priority(job), 2);
});

test('manual extraction carries its explicit tag into analysis and never consumes recent priority', async () => {
  const id = await article(), attemptTag = 'manual-extraction-review';
  const extraction = await enqueue(id, { step: 'extract', attemptTag });
  const [job] = await sql`SELECT data,singleton_key FROM pgboss.job WHERE id=${extraction}`;
  assert.equal(job!.data.attemptTag, attemptTag);
  assert.equal(job!.singleton_key, `manual:extract:${id}:${attemptTag}`);
  let handler: ((jobs: any[]) => Promise<unknown>) | undefined;
  await registerExtractionJobs({ work: async (_name: string, _options: unknown, callback: typeof handler) => { handler=callback; return 'fixture-worker'; } } as unknown as PgBoss);
  assert.ok(handler);
  // The body is already confirmed, so the real extraction callback forwards without any fetch.
  await handler([{ data: job!.data }]);
  const [analysis] = await sql`SELECT priority,data,singleton_key FROM pgboss.job
    WHERE name=${analyzeQueue} AND data->>'articleId'=${id}`;
  assert.equal(analysis!.data.attemptTag, attemptTag); assert.equal(analysis!.priority, 0);
  assert.equal(analysis!.singleton_key, `manual:analyze:${id}:${attemptTag}`);
  await refreshProcessingPriorities(); assert.equal(await priority(extraction), 0);
});
