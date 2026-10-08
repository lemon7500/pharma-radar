import { tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { eraseFeedback } from "@aihot/backend/admin/feedback";
import { FeedbackRejected, feedbackSourceHash, legacyFeedbackSourceHash, normalizeFeedbackPageUrl, submitFeedback } from "@aihot/backend/operations/feedback";
import { cleanupFeedbackUploads, failFeedback, feedbackLimits, prepareFeedbackUpload, reserveFeedback } from "@aihot/backend/operations/feedback-abuse";
import { putDurableFile } from "@aihot/backend/operations/durable-files";
import { buildApp } from "../apps/api/src/app.ts";

process.env.FEISHU_INTERNAL_ENABLED = "false";
config.dataDir = await mkdtemp(path.join(tmpdir(), "pharma-feedback-security-"));
const app = await buildApp();
const T = tag();
let ipSequence = 20;
const network = randomUUID().replace(/-/g, "").slice(0, 16).match(/.{4}/g)!.join(":");
const testSources = new Set<string>();
const ip = () => {
  const address = `2001:db8:${network}::${(ipSequence++).toString(16)}`;
  testSources.add(feedbackSourceHash(address));
  return address;
};
const png = await sharp({ create: { width: 3, height: 3, channels: 4, background: "green" } }).png().toBuffer();
const reject = (status: number, code?: string) => (error: unknown) => error instanceof FeedbackRejected && error.status === status && (!code || error.code === code);
const submit = (address: string, extra: Partial<Parameters<typeof submitFeedback>[0]> = {}) => submitFeedback({ content: `安全回归 ${T}`, ip: address, userAgent: "Chrome", ...extra });

after(async () => {
  await app.close();
  const sources = [...testSources];
  if (sources.length) {
    await sql`DELETE FROM feedback_submission_receipts WHERE source_hash IN ${sql(sources)}`;
    await sql`DELETE FROM feedback_submission_attempts WHERE source_hash IN ${sql(sources)}`;
    await sql`DELETE FROM feedback WHERE source_hash IN ${sql(sources)}`;
  }
  await closeDb();
  await rm(config.dataDir, { recursive: true, force: true });
});

async function caps<TValue>(values: Record<string, number>, run: () => Promise<TValue>): Promise<TValue> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = String(value);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("source limits and new bans stay fixed when a client changes its browser family", async () => {
  const address = ip();
  assert.equal(feedbackSourceHash(address, "Chrome"), feedbackSourceHash(address, "Firefox"));
  assert.notEqual(feedbackSourceHash(address), feedbackSourceHash(ip()));
  await caps({ FEEDBACK_PER_MINUTE: 1 }, async () => {
    await submit(address);
    await assert.rejects(submit(address, { userAgent: "Firefox" }), reject(429, "rate_limited"));
  });
  const banned = ip(), source = feedbackSourceHash(banned);
  await sql`INSERT INTO feedback_bans (source_hash, reason) VALUES (${source}, 'test')`;
  try { await assert.rejects(submit(banned, { userAgent: "Firefox" }), reject(403)); }
  finally { await sql`DELETE FROM feedback_bans WHERE source_hash = ${source}`; }
});

test("legacy browser-family bans still reject their existing matching source", async () => {
  const address = ip(), source = legacyFeedbackSourceHash(address, "Chrome");
  await sql`INSERT INTO feedback_bans (source_hash, reason) VALUES (${source}, 'legacy test')`;
  try { await assert.rejects(submit(address), reject(403)); }
  finally { await sql`DELETE FROM feedback_bans WHERE source_hash = ${source}`; }
});

test("quota persists across API instances and ignores a forged x-real-ip", async () => {
  const address = ip(), second = await buildApp();
  try {
    await caps({ FEEDBACK_PER_MINUTE: 1 }, async () => {
      const request = { method: "POST" as const, url: "/api/site/feedback", headers: { "x-forwarded-for": address, "x-real-ip": ip() }, payload: { content: `跨进程 ${T}` } };
      const first = await app.inject(request);
      assert.equal(first.statusCode, 201, first.body);
      const again = await second.inject({ ...request, headers: { ...request.headers, "x-real-ip": ip() } });
      assert.equal(again.statusCode, 429, again.body);
    });
  } finally { await second.close(); }
});

test("concurrent quota admission cannot exceed the per-source limit", async () => {
  const address = ip();
  await caps({ FEEDBACK_PER_MINUTE: 1, FEEDBACK_MAX_CONCURRENT: 16 }, async () => {
    const results = await Promise.allSettled([submit(address), submit(address, { userAgent: "Firefox" })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const denied = results.find((result) => result.status === "rejected");
    assert.ok(denied?.status === "rejected" && reject(429, "rate_limited")(denied.reason));
  });
});

test("identical retry returns its original feedback without spending quota or creating files", async () => {
  const address = ip(), submissionId = randomUUID();
  await caps({ FEEDBACK_PER_MINUTE: 1 }, async () => {
    const input = { submissionId, screenshot: { mime: "image/png", data: png } };
    const first = await submit(address, input);
    const again = await submit(address, { ...input, userAgent: "Firefox" });
    assert.equal(again.id, first.id);
    const [counts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM feedback_submission_attempts WHERE source_hash = ${feedbackSourceHash(address)}`;
    assert.equal(counts!.n, 1);
    await assert.rejects(submit(address, { ...input, content: "另一份内容" }), reject(409, "submission_conflict"));
  });
});

test("concurrent retries with the same UUID create exactly one feedback", async () => {
  const address = ip(), submissionId = randomUUID();
  const results = await Promise.allSettled([submit(address, { submissionId, screenshot: { mime: "image/png", data: png } }), submit(address, { submissionId, screenshot: { mime: "image/png", data: png } })]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  const ids = results.flatMap((result) => result.status === "fulfilled" ? [result.value.id] : []);
  assert.equal(new Set(ids).size, 1);
  for (const result of results) if (result.status === "rejected") assert.ok(reject(409, "submission_pending")(result.reason));
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM feedback WHERE source_hash = ${feedbackSourceHash(address)}`;
  assert.equal(count!.n, 1);
});

test("daily per-source and total quotas admit only the remaining allowance", async () => {
  const address = ip();
  await caps({ FEEDBACK_PER_MINUTE: 100, FEEDBACK_PER_DAY: 2 }, async () => {
    await submit(address); await submit(address);
    await assert.rejects(submit(address), reject(429, "daily_limit"));
  });
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM feedback_submission_attempts
    WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`;
  await caps({ FEEDBACK_TOTAL_PER_DAY: count!.n + 1 }, async () => {
    await submit(ip());
    await assert.rejects(submit(ip()), reject(429, "daily_limit"));
  });
});

test("upload budget rejection happens before storage and still permits text feedback", async () => {
  const address = ip();
  await caps({ FEEDBACK_UPLOAD_DAILY_BYTES: 1 }, async () => {
    await assert.rejects(submit(address, { screenshot: { mime: "image/png", data: png } }), reject(429, "upload_limit"));
    await submit(address);
  });
});

test("legacy screenshots without byte metadata are conservatively included in live storage", async () => {
  const [before] = await sql<{ bytes: number }[]>`SELECT coalesce(sum(coalesce(screenshot_bytes, 8388608)),0) AS bytes FROM feedback WHERE screenshot_key LIKE 'local:%'`;
  const [legacy] = await sql<{ id: number }[]>`INSERT INTO feedback (content, source_hash, screenshot_key) VALUES ('legacy storage test', ${T}, 'local:legacy-storage-test.png') RETURNING id`;
  try {
    await caps({ FEEDBACK_STORAGE_MAX_BYTES: before!.bytes + 8388608 - 1 }, async () => {
      await assert.rejects(submit(ip(), { screenshot: { mime: "image/png", data: png } }), reject(429, "upload_limit"));
      await submit(ip());
    });
  } finally { await sql`DELETE FROM feedback WHERE id = ${legacy!.id}`; }
});

test("fake types, damaged full image data, excessive pixels and animation are rejected", async () => {
  const large = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
  const gif = await sharp({ create: { width: 1, height: 1, channels: 4, background: "green" } }).gif().toBuffer();
  // Repeat the actual GIF image descriptor to make two frames while retaining a valid trailer.
  const descriptor = gif.indexOf(Buffer.from([0x2c]));
  const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(descriptor, -1), Buffer.from([0x3b])]);
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  assert.equal((await sharp(png.subarray(0, png.length - 16)).metadata()).width, 3, "a readable header alone is not enough");
  for (const screenshot of [
    { mime: "image/png", data: Buffer.from("not an image") },
    { mime: "image/jpeg", data: png },
    { mime: "image/png", data: png.subarray(0, png.length - 16) },
    { mime: "image/png", data: large },
    { mime: "image/gif", data: animated },
  ]) await assert.rejects(submit(ip(), { screenshot, allowLegacyGif: true }), reject(400));
});

test("legacy JSON accepts a real static GIF and stores a static PNG", async () => {
  const gif = await sharp({ create: { width: 2, height: 2, channels: 4, background: "green" } }).gif().toBuffer();
  const result = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": ip() }, payload: { content: "旧页面 GIF", screenshot: { mime: "image/gif", data: gif.toString("base64") } } });
  assert.equal(result.statusCode, 201, result.body);
  const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.ok(row!.screenshot_key.endsWith(".png"));
});

test("normalization strips image metadata and does not retain trailing payload bytes", async () => {
  const withMetadata = await sharp(png).jpeg().withMetadata({ exif: { IFD0: { Copyright: "private test metadata" } } }).toBuffer();
  const { id } = await submit(ip(), { screenshot: { mime: "image/jpeg", data: withMetadata } });
  const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  const data = await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6)));
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test("a cleanup following an uncertain successful commit never deletes a saved screenshot", async () => {
  const address = ip(), submissionId = randomUUID();
  const { id } = await submit(address, { submissionId, screenshot: { mime: "image/png", data: png } });
  const [row] = await sql<{ active_attempt: string; screenshot_key: string }[]>`SELECT r.active_attempt, f.screenshot_key FROM feedback_submission_receipts r
    JOIN feedback f ON f.id = r.feedback_id WHERE f.id = ${id}`;
  const storageKey = `feedback-screenshots/${row!.screenshot_key.slice(6)}`;
  await failFeedback({ id: row!.active_attempt, source: feedbackSourceHash(address), submissionId }, storageKey);
  assert.ok(existsSync(path.join(config.dataDir, storageKey)));
  const [attempt] = await sql<{ state: string }[]>`SELECT state FROM feedback_submission_attempts WHERE id = ${row!.active_attempt}::uuid`;
  assert.equal(attempt!.state, "succeeded");
});

test("failed and expired reservations release or clean their file accounting", async () => {
  const address = ip(), source = feedbackSourceHash(address), submissionId = randomUUID();
  const admission = await reserveFeedback(source, legacyFeedbackSourceHash(address, "Chrome"), submissionId, T, png.length);
  assert.ok("reservation" in admission);
  const reservation = admission.reservation;
  const storageKey = `feedback-screenshots/${reservation.id}.png`;
  await prepareFeedbackUpload(reservation, png.length, storageKey);
  await putDurableFile(storageKey, png, "image/png");
  await sql`UPDATE feedback_submission_attempts SET lease_until = now() - interval '1 second' WHERE id = ${reservation.id}::uuid`;
  await cleanupFeedbackUploads();
  assert.ok(!existsSync(path.join(config.dataDir, storageKey)));
  const [attempt] = await sql<{ state: string; screenshot_bytes: number; cleanup_needed: boolean }[]>`SELECT state, screenshot_bytes, cleanup_needed FROM feedback_submission_attempts WHERE id = ${reservation.id}::uuid`;
  assert.deepEqual({ ...attempt! }, { state: "failed", screenshot_bytes: png.length, cleanup_needed: false });
});

test("missing remote configuration cannot silently clear a remote orphan reservation", async () => {
  const address = ip(), source = feedbackSourceHash(address), submissionId = randomUUID();
  const admission = await reserveFeedback(source, legacyFeedbackSourceHash(address, "Chrome"), submissionId, T, png.length);
  assert.ok("reservation" in admission);
  const reservation = admission.reservation;
  const storageKey = `feedback-screenshots/${reservation.id}.png`;
  await prepareFeedbackUpload(reservation, png.length, storageKey);
  await putDurableFile(storageKey, png, "image/png");
  await sql`UPDATE feedback_submission_attempts SET storage_remote = true, lease_until = now() - interval '1 second' WHERE id = ${reservation.id}::uuid`;
  try {
    await cleanupFeedbackUploads();
    const [row] = await sql<{ cleanup_needed: boolean; screenshot_bytes: number }[]>`SELECT cleanup_needed, screenshot_bytes FROM feedback_submission_attempts WHERE id = ${reservation.id}::uuid`;
    assert.equal(row!.cleanup_needed, true);
    assert.equal(row!.screenshot_bytes, png.length);
    assert.ok(existsSync(path.join(config.dataDir, storageKey)));
  } finally {
    await sql`UPDATE feedback_submission_attempts SET storage_remote = false WHERE id = ${reservation.id}::uuid`;
    await cleanupFeedbackUploads();
  }
});

test("an uncertain remote upload keeps its bytes reserved until a delayed write can be removed", async () => {
  const address = ip(), submissionId = randomUUID(), lateCommit = gate();
  const objects = new Map<string, Buffer>();
  let lateWrite: Promise<void> | null = null, deletes = 0;
  const originalFetch = globalThis.fetch;
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_UPLOADS_BUCKET"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-storage-key";
  process.env.SUPABASE_UPLOADS_BUCKET = "test-feedback";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("http://127.0.0.1:1/storage/")) throw new Error("unexpected external request in isolated storage test");
    if (init?.method === "POST") {
      const key = decodeURIComponent(url.split("/object/test-feedback/")[1]!);
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      lateWrite = lateCommit.promise.then(() => { objects.set(key, bytes); });
      throw new Error("simulated upload response timeout");
    }
    if (init?.method === "DELETE") {
      deletes += 1;
      const body = JSON.parse(String(init.body)) as { prefixes: string[] };
      for (const key of body.prefixes) objects.delete(key);
      return Response.json([]);
    }
    throw new Error("unexpected storage request");
  }) as typeof fetch;
  try {
    await assert.rejects(submit(address, { submissionId, screenshot: { mime: "image/png", data: png } }), /durable upload failed/);
    const [attempt] = await sql<{ id: string; screenshot_bytes: number; cleanup_needed: boolean }[]>`SELECT a.id, a.screenshot_bytes, a.cleanup_needed
      FROM feedback_submission_attempts a JOIN feedback_submission_receipts r ON r.active_attempt = a.id
      WHERE r.source_hash = ${feedbackSourceHash(address)} AND r.submission_id = ${submissionId}::uuid`;
    assert.equal(attempt!.cleanup_needed, true);
    assert.ok(attempt!.screenshot_bytes > 0);
    assert.equal(deletes, 0, "deleting before a delayed upload commits is unsafe");
    await cleanupFeedbackUploads();
    assert.equal(deletes, 0);
    lateCommit.open();
    await lateWrite;
    assert.equal(objects.size, 1);
    await sql`UPDATE feedback_submission_attempts SET lease_until = now() - interval '1 second' WHERE id = ${attempt!.id}::uuid`;
    await cleanupFeedbackUploads();
    assert.equal(deletes, 1);
    assert.equal(objects.size, 0);
    const [after] = await sql<{ cleanup_needed: boolean }[]>`SELECT cleanup_needed FROM feedback_submission_attempts WHERE id = ${attempt!.id}::uuid`;
    assert.equal(after!.cleanup_needed, false);
  } finally {
    lateCommit.open(); await lateWrite;
    globalThis.fetch = originalFetch;
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test("pending UUID retries report a retry delay and ordinary bookkeeping expires", async () => {
  const address = ip(), source = feedbackSourceHash(address), submissionId = randomUUID();
  const first = await reserveFeedback(source, legacyFeedbackSourceHash(address, "Chrome"), submissionId, T, 0);
  assert.ok("reservation" in first);
  await assert.rejects(reserveFeedback(source, legacyFeedbackSourceHash(address, "Firefox"), submissionId, T, 0), (error: unknown) => reject(409, "submission_pending")(error) && (error as FeedbackRejected).retryAfter === 5);
  await failFeedback(first.reservation, null);
  await sql`UPDATE feedback_submission_attempts SET created_at = now() - interval '3 days' WHERE id = ${first.reservation.id}::uuid`;
  await sql`UPDATE feedback_submission_receipts SET updated_at = now() - interval '8 days' WHERE source_hash = ${source} AND submission_id = ${submissionId}::uuid`;
  await cleanupFeedbackUploads();
  assert.equal((await sql`SELECT 1 FROM feedback_submission_attempts WHERE id = ${first.reservation.id}::uuid`).length, 0);
  assert.equal((await sql`SELECT 1 FROM feedback_submission_receipts WHERE source_hash = ${source}`).length, 0);
});

test("body concurrency is rejected before a second multipart body is parsed", async () => {
  const instance = await buildApp(), held = gate(), reached = gate();
  let parsed = 0;
  instance.addHook("preParsing", async (_req, _reply, payload) => { parsed += 1; reached.open(); await held.promise; return payload; });
  try {
    await caps({ FEEDBACK_MAX_CONCURRENT: 1 }, async () => {
      const first = instance.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": ip() }, payload: { content: "保持请求等待" } });
      await reached.promise;
      const second = await instance.inject({ method: "POST", url: "/api/site/feedback", payload: { content: "不应解析" } });
      assert.equal(second.statusCode, 429);
      assert.equal(parsed, 1);
      held.open();
      assert.equal((await first).statusCode, 201);
    });
  } finally { held.open(); await instance.close(); }
});

test("one source cannot occupy every upload slot while other readers can still submit", async () => {
  const instance = await buildApp(), held = gate(), reached = gate(), address = ip();
  instance.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers["x-test-hold"] === "1") { reached.open(); await held.promise; }
    return payload;
  });
  try {
    const first = instance.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": address, "x-test-hold": "1" }, payload: { content: "第一条请求" } });
    await reached.promise;
    const same = await instance.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": address }, payload: { content: "同来源第二条" } });
    assert.equal(same.statusCode, 429);
    const other = await instance.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": ip() }, payload: { content: "另一位读者" } });
    assert.equal(other.statusCode, 201, other.body);
    held.open();
    assert.equal((await first).statusCode, 201);
  } finally { held.open(); await instance.close(); }
});

test("a stalled request body expires and releases its slot without limiting normal response work", async () => {
  const instance = await buildApp(), address = ip();
  await instance.listen({ host: "127.0.0.1", port: 0 });
  const port = (instance.server.address() as { port: number }).port;
  let stalled: http.ClientRequest | null = null;
  try {
    await caps({ FEEDBACK_BODY_TIMEOUT_MS: 50 }, async () => {
      const status = await new Promise<number>((resolve, rejectPromise) => {
        stalled = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/api/site/feedback", headers: { "content-type": "application/json", "content-length": "100", "x-forwarded-for": address } }, (response) => {
          response.resume(); response.on("end", () => resolve(response.statusCode!));
        });
        stalled.on("error", rejectPromise);
        stalled.write('{"content":"unfinished');
      });
      assert.equal(status, 408);
      const normal = await instance.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-forwarded-for": address }, payload: { content: "超时后正常提交" } });
      assert.equal(normal.statusCode, 201, normal.body);
    });
  } finally { (stalled as http.ClientRequest | null)?.destroy(); await instance.close(); }
});

test("URLs reject dangerous schemes and credential-bearing addresses without being fetched", () => {
  assert.equal(normalizeFeedbackPageUrl("/items/sample?x=1"), "/items/sample?x=1");
  assert.equal(normalizeFeedbackPageUrl("https://example.com/article"), "https://example.com/article");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "//example.com", "/\\example.com", "https://name:secret@example.com", "https://example.com/\nunsafe", "relative/path"]) assert.throws(() => normalizeFeedbackPageUrl(value), reject(400));
});

test("anonymous users cannot read feedback or screenshots; erasure also clears idempotency receipts", async () => {
  const address = ip(), submissionId = randomUUID();
  const { id } = await submit(address, { submissionId, screenshot: { mime: "image/png", data: png } });
  for (const url of ["/api/admin/feedback", `/api/admin/feedback/${id}/screenshot`]) {
    const result = await app.inject({ method: "GET", url });
    assert.equal(result.statusCode, 401);
    assert.match(String(result.headers["cache-control"]), /no-store/);
  }
  await eraseFeedback(id, "test erasure", "security-test");
  const [receipt] = await sql`SELECT 1 FROM feedback_submission_receipts WHERE feedback_id = ${id}`;
  assert.equal(receipt, undefined);
});

test("defaults keep the free service's admission and storage bounds explicit", () => {
  assert.deepEqual(feedbackLimits(), { perMinute: 5, perDay: 20, totalPerDay: 100, storageBytes: 100 * 1024 * 1024, uploadDailyBytes: 50 * 1024 * 1024, concurrent: 2, perIpConcurrent: 1, bodyTimeoutMs: 30_000 });
});
