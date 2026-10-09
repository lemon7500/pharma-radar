import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { BATCH_ADMISSION_KEY } from "@aihot/backend/operations/batch-admission";

const output = resolve(".data", `scheduler-admission-${randomUUID()}.txt`);
let saved: { value: unknown; updated_by: string | null; updated_at: string } | undefined;
let auditStart = 0;
let ready = false;
before(async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /_(test|ci)$/);
  [saved] = await sql`SELECT value, updated_by, updated_at::text AS updated_at FROM settings WHERE key=${BATCH_ADMISSION_KEY}`;
  const [audit] = await sql`SELECT coalesce(max(id),0) AS id FROM job_runs`;
  auditStart = audit!.id;
  await mkdir(resolve(".data"), { recursive: true });
  await sql`DELETE FROM settings WHERE key=${BATCH_ADMISSION_KEY}`;
  ready = true;
});
after(async () => {
  if (!ready) { await closeDb(); return; }
  if (saved) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${BATCH_ADMISSION_KEY},${sql.json(saved.value as never)},${saved.updated_by},${saved.updated_at})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`;
  else await sql`DELETE FROM settings WHERE key=${BATCH_ADMISSION_KEY}`;
  await sql`DELETE FROM job_runs WHERE job='batch.admission' AND id>${auditStart}`;
  await unlink(output).catch(() => {});
  await closeDb();
});
function run(extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["deploy/admit-batch.ts"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_RUN_ID: "90000000000001",
      BATCH_MIN_INTERVAL_MINUTES: "55", BATCH_TRIGGER_SOURCE: "cloudflare", ...extra },
  });
}

test("Actions output accepts one batch then skips without changing worker heartbeat", async () => {
  const heartbeats = await sql`SELECT key,value,updated_at FROM settings WHERE key='heartbeat.worker'`;
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout.trim()).admitted, true);
  const second = run({ BATCH_TRIGGER_SOURCE: "schedule", GITHUB_RUN_ID: "90000000000002" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).admitted, false);
  assert.equal(await readFile(output, "utf8"), "admitted=true\nadmitted=false\n");
  const [setting] = await sql`SELECT value FROM settings WHERE key=${BATCH_ADMISSION_KEY}`;
  assert.equal(setting!.value.source, "cloudflare-cron");
  assert.equal(setting!.value.ownerRunId, "90000000000001");
  const audits = await sql`SELECT status,detail FROM job_runs WHERE job='batch.admission' AND id>${auditStart} ORDER BY id`;
  assert.deepEqual(audits.map(row => row.status), ["ok", "skipped"]);
  assert.equal(audits[1]!.detail.admitted, false);
  assert.deepEqual(await sql`SELECT key,value,updated_at FROM settings WHERE key='heartbeat.worker'`, heartbeats);
});

test("invalid configuration fails without an Actions admission output or state changes", async () => {
  const original = await sql`SELECT value,updated_at FROM settings WHERE key=${BATCH_ADMISSION_KEY}`;
  const originalOutput = await readFile(output, "utf8");
  const invalid: Record<string, string>[] = [{ BATCH_MIN_INTERVAL_MINUTES: "0" }, { BATCH_TRIGGER_SOURCE: "untrusted" }, { GITHUB_RUN_ID: "credential-like-value" }];
  for (const extra of invalid) {
    const result = run(extra);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr.trim()), { stage: "batch.admission.failed" });
    assert.equal(result.stderr.includes(process.env.DATABASE_URL!), false);
  }
  assert.equal(await readFile(output, "utf8"), originalOutput);
  assert.deepEqual(await sql`SELECT value,updated_at FROM settings WHERE key=${BATCH_ADMISSION_KEY}`, original);
});
