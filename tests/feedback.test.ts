// Feedback reaches the internal Feishu chat with its screenshot even when Feishu fails at first: a
// failed upload or send is tried again, only the Feishu image key is kept, a screenshot that cannot be
// uploaded for a day is dropped (the text still goes), and imported feedback is never forwarded again.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { forwardFeedbackToFeishu } from "@aihot/backend/notify/feishu";
import { forwardPendingFeedback, submitFeedback } from "@aihot/backend/operations/feedback";
import { pendingFeedbackUploadCleanup, reserveFeedback } from "@aihot/backend/operations/feedback-abuse";
import { eraseFeedback } from "@aihot/backend/admin/feedback";

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "aihot-feedback-"));
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_INTERNAL_CHAT_ID = "oc_test";

// Feishu's message app, answered here: uploads and sends fail while the switches say so.
const feishu = { uploadFails: false, sendFails: false, uploads: 0, sent: [] as Array<{ title: string; content: unknown[][] }> };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://open.feishu.cn/")) return realFetch(input, init);
  if (url.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t", expire: 7200 });
  if (url.endsWith("/im/v1/images")) {
    feishu.uploads += 1;
    return Response.json(feishu.uploadFails ? { code: 99, msg: "upload broken" } : { code: 0, data: { image_key: `img_${T}` } });
  }
  if (url.includes("/im/v1/messages")) {
    if (feishu.sendFails) return Response.json({ code: 99, msg: "send broken" });
    const content = JSON.parse(JSON.parse(String(init?.body)).content).zh_cn;
    feishu.sent.push(content);
    return Response.json({ code: 0, data: { message_id: "m1" } });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

let n = 0;
async function submit(): Promise<{ id: number; file: string }> {
  n += 1;
  // Submitted while forwarding is off, so the test drives every attempt itself.
  delete process.env.FEISHU_INTERNAL_ENABLED;
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: n, g: 10, b: 20, alpha: 1 } } }).png().toBuffer();
  const { id } = await submitFeedback({ content: `反馈 ${T}-${n}`, screenshot: { mime: "image/png", data: image }, ip: `203.0.113.${n}`, userAgent: "test" });
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return { id, file: path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice("local:".length)) };
}
const state = async (id: number) =>
  (await sql<{ forwarded: boolean; forward_error: string | null; screenshot_key: string | null }[]>`
    SELECT forwarded_at IS NOT NULL AS forwarded, forward_error, screenshot_key FROM feedback WHERE id = ${id}`)[0]!;
const sentFor = (id: number) => feishu.sent.find((m) => m.title === `反馈 #${id}`);
const olderBy = (id: number, interval: string) => sql`UPDATE feedback SET created_at = now() - ${interval}::interval WHERE id = ${id}`;

test("a failed screenshot upload keeps the feedback waiting, and the sweep sends it with the image", async () => {
  const { id, file } = await submit();
  assert.equal((await state(id)).forward_error, "pending");
  feishu.uploadFails = true;
  await assert.rejects(forwardFeedbackToFeishu(id));
  const waiting = await state(id);
  assert.deepEqual([waiting.forwarded, waiting.forward_error], [false, "feishu upload: upload broken"], "the reason is kept for the admin");
  assert.ok(existsSync(file) && !sentFor(id), "nothing is sent without the screenshot yet");

  feishu.uploadFails = false;
  await olderBy(id, "10 minutes");
  await forwardPendingFeedback();
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: `feishu:img_${T}` });
  assert.ok(sentFor(id)?.content.some((p) => JSON.stringify(p).includes(`img_${T}`)), "the message carries the image");
  assert.ok(!existsSync(file), "the local file is gone once uploaded");
});

test("a send that fails after the upload goes out with the same image next time", async () => {
  const { id, file } = await submit();
  feishu.sendFails = true;
  await assert.rejects(forwardFeedbackToFeishu(id));
  assert.equal((await state(id)).screenshot_key, `feishu:img_${T}`);
  assert.ok(!existsSync(file));
  feishu.sendFails = false;
  assert.equal(await forwardFeedbackToFeishu(id), "sent");
  assert.ok(sentFor(id)?.content.some((p) => JSON.stringify(p).includes(`img_${T}`)), "the uploaded image is not lost");
});

test("a screenshot that cannot be uploaded for a day is dropped, and the text still goes", async () => {
  const { id, file } = await submit();
  feishu.uploadFails = true;
  await olderBy(id, "25 hours");
  assert.equal(await forwardFeedbackToFeishu(id), "sent");
  feishu.uploadFails = false;
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: "gone:upload" });
  assert.ok(!existsSync(file), "no copy of the screenshot is kept");
  assert.ok(JSON.stringify(sentFor(id)?.content).includes("截图未能上传"), "the chat is told the screenshot is missing");
});

test("imported feedback that was never forwarded is not sent now", async () => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, source_hash, created_at) VALUES (${`旧反馈 ${T}`}, ${`legacy:${T}`}, now() - interval '10 minutes') RETURNING id`;
  await forwardPendingFeedback();
  assert.equal((await state(row!.id)).forwarded, false);
  assert.equal(sentFor(row!.id), undefined);
});

/** Deletion is mocked at fetch: no real Supabase or Feishu request can leave these tests. */
async function deletionFixture(run: (storage: { fails: boolean; present: boolean; deletes: number; configure(): void }) => Promise<void>) {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_UPLOADS_BUCKET", "FEEDBACK_STORAGE_MAX_BYTES", "FEISHU_INTERNAL_ENABLED"];
  const before = new Map(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const storage = { fails: true, present: true, deletes: 0 };
  const configure = () => {
    process.env.SUPABASE_URL = "https://fixture-storage.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-storage-secret";
    process.env.SUPABASE_UPLOADS_BUCKET = "fixture-feedback";
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://fixture-storage.invalid/")) {
      assert.equal(init?.method, "DELETE", "the cache already contains the screenshot; only deletion reaches the fake store");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-storage-secret");
      storage.deletes += 1;
      if (storage.fails) return Response.json({ error: "unavailable", message: "fixture deletion failed" }, { status: 503 });
      storage.present = false;
      return Response.json([]);
    }
    if (url.startsWith("https://open.feishu.cn/")) return previousFetch(input, init);
    throw new Error("Unexpected network request in screenshot cleanup test");
  }) as typeof fetch;
  // Submission first uses the local fixture; then the stored remote flag models a durable original.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_UPLOADS_BUCKET;
  try {
    await run(Object.assign(storage, { configure }));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    feishu.uploadFails = feishu.sendFails = false;
  }
}

const cleanupState = async (id: number) => (await sql<{
  screenshot_key: string | null; screenshot_cleanup_key: string | null; screenshot_bytes: number;
  forwarded: boolean; forward_error: string | null;
}[]>`SELECT screenshot_key, screenshot_cleanup_key, screenshot_bytes, forwarded_at IS NOT NULL AS forwarded, forward_error
  FROM feedback WHERE id = ${id}`)[0]!;

test("deletion failure after a successful upload preserves the image and accounts for its original until a disabled sweep cleans it", async () => {
  await deletionFixture(async storage => {
    const pendingBefore = await pendingFeedbackUploadCleanup();
    const { id, file } = await submit();
    await sql`UPDATE feedback SET screenshot_remote = true WHERE id = ${id}`;
    storage.configure();
    const uploads = feishu.uploads;
    assert.equal(await forwardFeedbackToFeishu(id), "sent");
    const waiting = await cleanupState(id);
    assert.equal(waiting.screenshot_key, `feishu:img_${T}`);
    assert.equal(waiting.screenshot_cleanup_key, `feedback-screenshots/${path.basename(file)}`);
    assert.ok(waiting.screenshot_bytes > 0 && existsSync(file) && storage.present);
    assert.equal(await pendingFeedbackUploadCleanup(), pendingBefore + 1, "the hourly maintenance summary counts a committed original");
    assert.ok(sentFor(id)?.content.some(p => JSON.stringify(p).includes(`img_${T}`)));
    const [count] = await sql<{ bytes: number }[]>`SELECT
      (SELECT coalesce(sum(coalesce(screenshot_bytes, 8388608)),0) FROM feedback
        WHERE screenshot_key LIKE 'local:%' OR screenshot_cleanup_key IS NOT NULL)
      + (SELECT coalesce(sum(screenshot_bytes),0) FROM feedback_submission_attempts WHERE state = 'pending' OR cleanup_needed) AS bytes`;
    process.env.FEEDBACK_STORAGE_MAX_BYTES = String(count!.bytes);
    await assert.rejects(reserveFeedback(`cleanup-source-${id}`, `cleanup-legacy-${id}`, randomUUID(), "fixture-payload", 1),
      (error: unknown) => (error as { code?: string }).code === "upload_limit");
    delete process.env.FEEDBACK_STORAGE_MAX_BYTES;
    storage.fails = false;
    process.env.FEISHU_INTERNAL_ENABLED = "false";
    await forwardPendingFeedback();
    const done = await cleanupState(id);
    assert.equal(done.screenshot_cleanup_key, null);
    assert.equal(done.screenshot_bytes, 0);
    assert.ok(done.forwarded && !existsSync(file) && !storage.present);
    assert.equal(await pendingFeedbackUploadCleanup(), pendingBefore, "only confirmed deletion clears the maintenance count");
    assert.equal(feishu.uploads, uploads + 1, "cleanup does not reupload an image");
    assert.equal(feishu.sent.filter(m => m.title === `反馈 #${id}`).length, 1, "cleanup does not resend the feedback");
  });
});

test("an old feedback without an attempt receipt keeps its successful Feishu image when deletion fails", async () => {
  await deletionFixture(async storage => {
    const { id, file } = await submit();
    const [receipt] = await sql<{ active_attempt: string }[]>`SELECT active_attempt FROM feedback_submission_receipts WHERE feedback_id = ${id}`;
    await sql`DELETE FROM feedback_submission_receipts WHERE feedback_id = ${id}`;
    await sql`DELETE FROM feedback_submission_attempts WHERE id = ${receipt!.active_attempt}::uuid`;
    await sql`UPDATE feedback SET screenshot_remote = true, created_at = now() - interval '25 hours' WHERE id = ${id}`;
    storage.configure();
    assert.equal(await forwardFeedbackToFeishu(id), "sent");
    const waiting = await cleanupState(id);
    assert.equal(waiting.screenshot_key, `feishu:img_${T}`, "cleanup errors cannot enter the upload give-up branch");
    assert.ok(waiting.screenshot_cleanup_key && existsSync(file));
    assert.ok(sentFor(id)?.content.some(p => JSON.stringify(p).includes(`img_${T}`)));
    storage.fails = false;
    process.env.FEISHU_INTERNAL_ENABLED = "false";
    await forwardPendingFeedback();
    assert.equal((await cleanupState(id)).screenshot_cleanup_key, null);
    assert.ok(!existsSync(file) && !storage.present);
  });
});

test("a given-up upload remains accounted for when deletion fails, and the message does not claim it was deleted", async () => {
  await deletionFixture(async storage => {
    const { id, file } = await submit();
    await sql`UPDATE feedback SET screenshot_remote = true, created_at = now() - interval '25 hours' WHERE id = ${id}`;
    storage.configure();
    feishu.uploadFails = true;
    assert.equal(await forwardFeedbackToFeishu(id), "sent");
    const waiting = await cleanupState(id);
    assert.equal(waiting.screenshot_key, "gone:upload");
    assert.ok(waiting.screenshot_cleanup_key && waiting.screenshot_bytes > 0 && existsSync(file));
    assert.ok(JSON.stringify(sentFor(id)?.content).includes("等待清理"));
    assert.ok(!JSON.stringify(sentFor(id)?.content).includes("已删除"));
    storage.fails = false;
    process.env.FEISHU_INTERNAL_ENABLED = "false";
    await forwardPendingFeedback();
    assert.equal((await cleanupState(id)).screenshot_cleanup_key, null);
    assert.ok(!existsSync(file) && !storage.present);
  });
});

test("missing remote configuration cannot release a forwarded screenshot's accounting or remove only its cache", async () => {
  await deletionFixture(async storage => {
    const { id, file } = await submit();
    await sql`UPDATE feedback SET screenshot_remote = true WHERE id = ${id}`;
    assert.equal(await forwardFeedbackToFeishu(id), "sent");
    assert.ok((await cleanupState(id)).screenshot_cleanup_key && existsSync(file));
    process.env.FEISHU_INTERNAL_ENABLED = "false";
    await forwardPendingFeedback();
    assert.ok((await cleanupState(id)).screenshot_cleanup_key && existsSync(file));
    assert.equal(storage.deletes, 0);
    storage.configure();
    storage.fails = false;
    await forwardPendingFeedback();
    assert.equal((await cleanupState(id)).screenshot_cleanup_key, null);
    assert.ok(!existsSync(file) && !storage.present);
  });
});

test("administrator erasure retries a forwarded screenshot's pending durable original", async () => {
  await deletionFixture(async storage => {
    const { id, file } = await submit();
    await sql`UPDATE feedback SET screenshot_remote = true WHERE id = ${id}`;
    storage.configure();
    await forwardFeedbackToFeishu(id);
    await assert.rejects(eraseFeedback(id, "fixture erasure", "test"), /durable deletion failed/);
    assert.ok((await cleanupState(id)).screenshot_cleanup_key && existsSync(file));
    storage.fails = false;
    assert.deepEqual(await eraseFeedback(id, "fixture erasure", "test"), { erased: true });
    const done = await cleanupState(id);
    assert.equal(done.screenshot_cleanup_key, null);
    assert.equal(done.screenshot_key, null);
    assert.ok(!existsSync(file) && !storage.present);
  });
});
