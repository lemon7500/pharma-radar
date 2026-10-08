import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedbackSubmission } from "../app/lib/feedback-submit.ts";

const draft = { content: "摘要需要核对", email: "", pageUrl: "https://example.org/items/test" };

test("uncertain feedback responses reuse the receipt key, while edited material starts a new submission", async () => {
  const client = new FeedbackSubmission();
  const ids: string[] = [];
  const mock: typeof fetch = async (_input, init) => {
    const form = init!.body as FormData;
    ids.push(String(form.get("submissionId")));
    assert.deepEqual([form.get("content"), form.get("pageUrl")], [draft.content, draft.pageUrl]);
    if (ids.length === 1) throw new TypeError("Response lost");
    return Response.json({ id: 10 });
  };
  await assert.rejects(client.send(draft, null, mock));
  await client.send(draft, null, mock);
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0]!, /^[a-f0-9-]{36}$/);
  client.complete();
  await client.send(draft, null, mock);
  assert.notEqual(ids[2], ids[1]);
  await client.send({ ...draft, email: "reader@example.org" }, null, mock);
  assert.notEqual(ids[3], ids[2]);
});

test("a stalled feedback request is cancelled and can be retried with the same receipt key", async () => {
  const client = new FeedbackSubmission();
  let firstId: string | null = null;
  const hold = setTimeout(() => {}, 200);
  try {
    await assert.rejects(client.send(draft, null, async (_input, init) => {
      firstId = String((init!.body as FormData).get("submissionId"));
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }, 20), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
    await client.send(draft, null, async (_input, init) => {
      assert.equal(String((init!.body as FormData).get("submissionId")), firstId);
      return Response.json({ id: 10 });
    });
  } finally { clearTimeout(hold); }
});
