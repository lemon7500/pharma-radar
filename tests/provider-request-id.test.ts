// Synthetic provider responses only. setup refuses databases outside *_test/*_ci.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { paidRequest, ProviderRejectedError, ReceiptUnknownError, rejectReceivedResponse } from "@aihot/backend/providers/receipts";

const originalFetch = globalThis.fetch;
const originalCallsEnabled = config.modelCallsEnabled;
config.modelCallsEnabled = true;
process.env.DEEPSEEK_BASE_URL = "https://provider.stub.invalid/v1";
process.env.DEEPSEEK_API_KEY = "synthetic-test-key";
after(async () => {
  globalThis.fetch = originalFetch;
  config.modelCallsEnabled = originalCallsEnabled;
  await closeDb();
});

const request = () => {
  const subject = `request-id-${tag()}`;
  return { service: "invariant-request-id", purpose: "invariant_test", subject, identity: { subject } };
};
const ask = (subject: string) => chatJson({
  model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "request-id-test",
  system: "Return synthetic JSON", user: subject, schema: z.object({ ok: z.boolean() }),
});
async function recorded(subject: string) {
  const rows = await sql<{
    receipt_id: number; receipt_status: string; receipt_request_id: string | null; has_response: boolean;
    attempt: number; attempt_status: string; attempt_request_id: string | null;
  }[]>`SELECT r.id AS receipt_id,r.status AS receipt_status,r.request_id AS receipt_request_id,
    (r.response IS NOT NULL) AS has_response,a.attempt,a.status AS attempt_status,a.request_id AS attempt_request_id
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${subject} ORDER BY a.attempt`;
  assert.ok(rows.length > 0);
  return rows;
}

test("a successful response header survives body failure on this attempt while unknown remains blocked", async () => {
  const subject = `body-failure-${tag()}`, bodyError = new Error("synthetic body read failure");
  let sent = 0;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response(new ReadableStream({ start(controller) { controller.error(bodyError); } }), {
      status: 200, headers: { "x-request-id": "synthetic-body-failure-id" },
    });
  };
  try {
    await assert.rejects(ask(subject), (error: unknown) => error === bodyError);
    const [row] = await recorded(subject);
    assert.equal(row!.receipt_status, "unknown");
    assert.equal(row!.receipt_request_id, null);
    assert.equal(row!.has_response, false);
    assert.equal(row!.attempt_status, "unknown");
    assert.equal(row!.attempt_request_id, "synthetic-body-failure-id");
    assert.ok(!String(bodyError).includes("synthetic-body-failure-id"));
    await assert.rejects(ask(subject), ReceiptUnknownError);
    assert.equal(sent, 1, "an observed ID does not allow another provider request");
    assert.equal((await recorded(subject)).length, 1, "blocked reuse does not add a paid attempt");
  } finally { globalThis.fetch = originalFetch; }
});

test("unknown diagnostics reject malformed or oversized IDs without truncation", async () => {
  for (const value of [null, undefined, 123, {}, "", " ", "bad\nid", "\rleading-control", "trailing-control\n", "bad\0id", "a".repeat(257)]) {
    const req = request();
    await assert.rejects(paidRequest(req, async (context) => {
      context.observeRequestId(value);
      throw new Error("synthetic failure without accepted ID");
    }));
    assert.equal((await recorded(req.subject))[0]!.attempt_request_id, null);
  }
  const req = request(), longest = "a".repeat(256);
  await assert.rejects(paidRequest(req, async (context) => {
    context.observeRequestId(longest);
    context.observeRequestId("replacement-id");
    context.observeRequestId("bad\nreplacement");
    throw new Error("synthetic failure after accepted ID");
  }));
  assert.equal((await recorded(req.subject))[0]!.attempt_request_id, longest, "retain the first complete ID only");
});

test("a new unknown attempt never borrows or overwrites the preceding receipt ID or answer", async () => {
  for (const newId of [null, "synthetic-new-attempt-id"]) {
    const req = request();
    const first = await paidRequest(req, async () => ({ response: { old: true }, requestId: "synthetic-old-id" }));
    await rejectReceivedResponse(first.receiptId, "synthetic old result rejected");
    await assert.rejects(paidRequest(req, async (context) => {
      context.observeRequestId(newId);
      throw new Error("synthetic retry body failure");
    }));
    const rows = await recorded(req.subject);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.attempt_request_id, "synthetic-old-id");
    assert.equal(rows[1]!.attempt_request_id, newId);
    assert.equal(rows[1]!.attempt_status, "unknown");
    assert.equal(rows[1]!.receipt_status, "unknown");
    assert.equal(rows[1]!.receipt_request_id, "synthetic-old-id");
    assert.equal(rows[1]!.has_response, true, "top-level historical answer is not this attempt's result");
  }
});

test("concurrent logical requests keep diagnostic IDs inside their own attempt", async () => {
  const requests = [request(), request()];
  let observed = 0, release!: () => void;
  const bothObserved = new Promise<void>((resolve) => { release = resolve; });
  const settled = await Promise.allSettled(requests.map((req, index) => paidRequest(req, async (context) => {
    context.observeRequestId(`synthetic-concurrent-${index}`);
    observed += 1;
    if (observed === requests.length) release();
    await bothObserved;
    throw new Error("synthetic concurrent body failure");
  })));
  assert.ok(settled.every((result) => result.status === "rejected"));
  for (const [index, req] of requests.entries()) {
    const [row] = await recorded(req.subject);
    assert.equal(row!.attempt_request_id, `synthetic-concurrent-${index}`);
    assert.equal(row!.attempt_status, "unknown");
  }
});

test("clear HTTP rejection and pre-header connection failure retain their existing classification", async () => {
  const refusedSubject = `rejection-${tag()}`;
  globalThis.fetch = async () => new Response('{"error":"synthetic limit"}', {
    status: 429, headers: { "x-request-id": "synthetic-rejection-id" },
  });
  try {
    await assert.rejects(ask(refusedSubject), (error: unknown) => error instanceof ProviderRejectedError && error.status === 429 && error.retryable);
    const [refused] = await recorded(refusedSubject);
    assert.equal(refused!.attempt_status, "failed");
    assert.equal(refused!.attempt_request_id, "synthetic-rejection-id");
    const connectSubject = `connect-failure-${tag()}`;
    globalThis.fetch = async () => { throw Object.assign(new Error("synthetic connect failure"), { cause: { code: "ENOTFOUND" } }); };
    await assert.rejects(ask(connectSubject), (error: unknown) => error instanceof ProviderRejectedError && error.status === null && error.retryable);
    const [connect] = await recorded(connectSubject);
    assert.equal(connect!.attempt_status, "failed");
    assert.equal(connect!.attempt_request_id, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("successful JSON IDs, usage and received-response reuse keep their previous behavior", async () => {
  const subject = `success-${tag()}`;
  let sent = 0;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response(JSON.stringify({ id: "synthetic-json-id", choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 7 } }), {
      status: 200, headers: { "x-request-id": "synthetic-header-id" },
    });
  };
  try {
    assert.deepEqual((await ask(subject)).data, { ok: true });
    const reused = await ask(subject);
    assert.equal(reused.reused, true);
    assert.equal(reused.usage?.total_tokens, 7);
    assert.equal(sent, 1);
    const [row] = await recorded(subject);
    assert.equal(row!.receipt_request_id, "synthetic-json-id");
    assert.equal(row!.attempt_request_id, "synthetic-json-id");
    assert.equal(row!.attempt_status, "received");
  } finally { globalThis.fetch = originalFetch; }
});

test("existing zero-argument provider callbacks remain compatible", async () => {
  const req = request();
  const result = await paidRequest(req, async () => ({ response: { ok: true } }));
  assert.deepEqual(result.response, { ok: true });
  assert.equal((await recorded(req.subject))[0]!.attempt_request_id, null);
});
