// Only a disposable local test database is used; ordinary fixtures roll back their settings changes.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { admitBatch, BATCH_ADMISSION_KEY, DEFAULT_BATCH_INTERVAL_MINUTES, type BatchAdmissionOptions } from "@aihot/backend/operations/batch-admission";

const rollback = new Error("rollback batch admission fixture");
before(() => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /_(test|ci)$/);
});
after(closeDb);

async function fixture(run: (tx: Tx) => Promise<void>) {
  try {
    await sql.begin(async tx => {
      await tx`DELETE FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
      await run(tx);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

test("the missing first setting is admitted with a DB-clock 55 minute window", async () => fixture(async tx => {
  const [before] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  const accepted = await admitBatch({ source: "github-actions", ownerRunId: "37908415361" }, tx);
  const [after] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  assert.equal(accepted.admitted, true);
  assert.ok(accepted.admittedAt >= before!.at && accepted.admittedAt <= after!.at);
  assert.equal(accepted.nextEligibleAt.getTime() - accepted.admittedAt.getTime(), DEFAULT_BATCH_INTERVAL_MINUTES * 60_000);
  const [setting] = await tx`SELECT value,updated_by FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.deepEqual(setting!.value, { version: 1, intervalMinutes: 55, source: "github-actions", ownerRunId: "37908415361" });
  assert.equal(setting!.updated_by, "system:batch-admission");
}));

test("the 55 minute lower boundary is inclusive and an earlier attempt is denied", async () => fixture(async tx => {
  await tx`INSERT INTO settings (key,value,updated_at) VALUES (${BATCH_ADMISSION_KEY}, '{}', clock_timestamp() - interval '54 minutes 30 seconds')`;
  assert.equal((await admitBatch({}, tx)).admitted, false);
  await tx`UPDATE settings SET updated_at = clock_timestamp() - interval '55 minutes' WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.equal((await admitBatch({}, tx)).admitted, true);
  assert.equal((await admitBatch({}, tx)).admitted, false);
}));

test("rejected attempts retain the accepted run metadata and never extend the window", async () => fixture(async tx => {
  const first = await admitBatch({ source: "github-actions", ownerRunId: "123" }, tx);
  const [original] = await tx`SELECT value,updated_by,updated_at FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  for (let i = 0; i < 4; i++) {
    const denied = await admitBatch({ source: "cloudflare-cron", ownerRunId: "456" }, tx);
    assert.equal(denied.admitted, false);
    assert.deepEqual(denied.admittedAt, first.admittedAt);
    assert.deepEqual(denied.nextEligibleAt, first.nextEligibleAt);
  }
  const [unchanged] = await tx`SELECT value,updated_by,updated_at FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.deepEqual(unchanged, original);
}));

test("future DB timestamps are treated conservatively and malformed legacy JSON cannot bypass or break expiry", async () => fixture(async tx => {
  await tx`INSERT INTO settings (key,value,updated_at) VALUES (${BATCH_ADMISSION_KEY}, '"legacy invalid metadata"', clock_timestamp() + interval '10 minutes')`;
  const future = await admitBatch({}, tx);
  assert.equal(future.admitted, false);
  const [clock] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  assert.ok(future.nextEligibleAt.getTime() - clock!.at.getTime() > 64 * 60_000);
  await tx`UPDATE settings SET updated_at = clock_timestamp() - interval '56 minutes' WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.equal((await admitBatch({}, tx)).admitted, true);
  const [repaired] = await tx`SELECT value FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.deepEqual(repaired!.value, { version: 1, intervalMinutes: 55 });
}));

test("an accepted run that fails is retryable after its original window without a release operation", async () => fixture(async tx => {
  assert.equal((await admitBatch({}, tx)).admitted, true);
  assert.equal((await admitBatch({}, tx)).admitted, false);
  await tx`UPDATE settings SET updated_at = clock_timestamp() - interval '55 minutes' WHERE key = ${BATCH_ADMISSION_KEY}`;
  assert.equal((await admitBatch({}, tx)).admitted, true);
}));

test("invalid intervals and unsafe optional metadata fail closed before writing the admission row", async () => fixture(async tx => {
  const invalid: unknown[] = [
    ...[0, -1, 54, 55.5, 1441, NaN, Infinity, "55", null].map(intervalMinutes => ({ intervalMinutes })),
    { source: "credential-like-value" }, { ownerRunId: "https://example.org/run/1" }, { ownerRunId: "0" },
    { ownerRunId: "1".repeat(21) }, { ownerRunId: 123 }, { override: true }, null, [],
  ];
  for (const options of invalid) await assert.rejects(admitBatch(options as BatchAdmissionOptions, tx), /Invalid batch|Batch interval/);
  assert.equal((await tx`SELECT key FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`).length, 0);
  assert.equal((await admitBatch({ intervalMinutes: 1440, source: "local" }, tx)).admitted, true);
}));

test("independent connections admit exactly one competing first run and restore the saved test setting", async () => {
  const [saved] = await sql`SELECT value,updated_by,updated_at::text AS updated_at FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  const connections = Array.from({ length: 20 }, () => postgres(process.env.DATABASE_URL!, { max: 1, idle_timeout: 1, connect_timeout: 10 }));
  try {
    await sql`DELETE FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
    // BEGIN on each dedicated connection gives a genuine row-lock race; the winner must commit.
    const results = await Promise.all(connections.map((db, i) => db.begin(tx => admitBatch({ ownerRunId: String(i + 1) }, tx as unknown as Tx))));
    assert.equal(results.filter(result => result.admitted).length, 1);
    const accepted = results.find(result => result.admitted)!;
    for (const result of results) {
      assert.deepEqual(result.admittedAt, accepted.admittedAt);
      assert.deepEqual(result.nextEligibleAt, accepted.nextEligibleAt);
    }
    const [stored] = await sql`SELECT updated_at FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
    assert.deepEqual(stored!.updated_at, accepted.admittedAt);
  } finally {
    await Promise.all(connections.map(db => db.end({ timeout: 5 })));
    if (saved) await sql`INSERT INTO settings (key,value,updated_by,updated_at)
      VALUES (${BATCH_ADMISSION_KEY}, ${sql.json(saved.value)}, ${saved.updated_by}, ${saved.updated_at})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`;
    else await sql`DELETE FROM settings WHERE key = ${BATCH_ADMISSION_KEY}`;
  }
});
