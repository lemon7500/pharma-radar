import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// Private addresses are allowed only in this isolated test process; every real request is loopback.
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
process.env.MODEL_CALLS_ENABLED = "false";
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";
const { guardedFetch } = await import("@aihot/backend/lib/http-fetch");

const hits: Array<{ origin: string; method: string; headers: IncomingMessage["headers"]; body: string }> = [];
let secondBase = "";
function server(origin: string) {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url ?? "/", "http://test.local");
    if (url.pathname.startsWith("/redirect/")) {
      const status = Number(url.pathname.split("/").pop());
      const target = url.searchParams.get("target") ?? "/capture";
      res.writeHead(status, { location: target });
      return res.end();
    }
    if (url.pathname === "/return") {
      res.writeHead(302, { location: `${firstBase}/capture` });
      return res.end();
    }
    hits.push({ origin, method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
}
const first = server("first"), second = server("second");
await Promise.all([first, second].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
const firstBase = `http://127.0.0.1:${(first.address() as { port: number }).port}`;
secondBase = `http://127.0.0.1:${(second.address() as { port: number }).port}`;
const syntheticHeaders = { Authorization: "Bearer synthetic-token", Cookie: "test=synthetic", "X-API-Key": "synthetic-key", accept: "text/plain" };
const redirect = (status: number, target?: string) => `${firstBase}/redirect/${status}${target ? `?${new URLSearchParams({ target })}` : ""}`;
after(async () => {
  for (const s of [first, second]) s.closeAllConnections();
  await Promise.all([first, second].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

test("same-origin redirects retain credentials and 307/308 retain the body", async () => {
  for (const status of [307, 308]) {
    await guardedFetch(redirect(status), { method: "POST", headers: syntheticHeaders, body: "synthetic-body" });
    assert.equal(hits.at(-1)!.origin, "first");
    assert.equal(hits.at(-1)!.method, "POST");
    assert.equal(hits.at(-1)!.body, "synthetic-body");
    assert.equal(hits.at(-1)!.headers.authorization, syntheticHeaders.Authorization);
    assert.equal(hits.at(-1)!.headers.cookie, syntheticHeaders.Cookie);
    assert.equal(hits.at(-1)!.headers["x-api-key"], syntheticHeaders["X-API-Key"]);
  }
});

test("cross-origin GET redirects strip credentials, including when returning to the original host", async () => {
  for (const target of [`${secondBase}/capture`, `${secondBase}/return`]) {
    await guardedFetch(redirect(302, target), { headers: syntheticHeaders });
    const hit = hits.at(-1)!;
    assert.equal(hit.headers.authorization, undefined);
    assert.equal(hit.headers.cookie, undefined);
    assert.equal(hit.headers["x-api-key"], undefined);
    assert.equal(hit.headers.accept, "text/plain");
  }
});

test("301/302 POST and 303 PATCH become bodyless GET without body headers", async () => {
  for (const [status, method] of [[301, "POST"], [302, "POST"], [303, "PATCH"]] as const) {
    await guardedFetch(redirect(status, `${secondBase}/capture`), {
      method, headers: { ...syntheticHeaders, "content-type": "application/json", "content-language": "en" },
      body: JSON.stringify({ key: "synthetic-body-key" }),
    });
    const hit = hits.at(-1)!;
    assert.equal(hit.method, "GET");
    assert.equal(hit.body, "");
    assert.equal(hit.headers["content-type"], undefined);
    assert.equal(hit.headers["content-language"], undefined);
    assert.equal(hit.headers.authorization, undefined);
  }
});

test("cross-origin redirects cannot replay a retained request body", async () => {
  for (const [status, method] of [[307, "POST"], [308, "POST"], [301, "PATCH"], [302, "PATCH"]] as const) {
    const before = hits.length;
    await assert.rejects(guardedFetch(redirect(status, `${secondBase}/capture`), { method, body: "synthetic-secret" }), /Cross-origin redirect/);
    assert.equal(hits.length, before, "the destination is never contacted");
  }
});

test("cross-origin redirects reject keys in the original URL or redirect destination", async () => {
  for (const url of [
    `${redirect(302, `${secondBase}/capture`)}&key=synthetic-key`,
    redirect(302, `${secondBase}/capture?api_key=synthetic-key`),
  ]) {
    const before = hits.length;
    await assert.rejects(guardedFetch(url), /Cross-origin redirect with URL credentials/);
    assert.equal(hits.length, before);
  }
});

test("303 preserves HEAD and 304 is not followed", async () => {
  await guardedFetch(redirect(303), { method: "HEAD" });
  assert.equal(hits.at(-1)!.method, "HEAD");
  const before = hits.length;
  const response = await guardedFetch(redirect(304));
  assert.equal(response.status, 304);
  assert.equal(hits.length, before);
});

test("HTTPS downgrade rejects header, body and query credentials while anonymous redirects remain usable", async () => {
  const previous = getGlobalDispatcher();
  const mocked = new MockAgent();
  mocked.disableNetConnect();
  mocked.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  setGlobalDispatcher(mocked);
  try {
    const origin = mocked.get("https://synthetic-provider.test");
    for (const opts of [
      { headers: syntheticHeaders },
      { method: "POST", body: "synthetic-key" },
      {},
    ]) {
      const path = Object.keys(opts).length ? "/start" : "/start?key=synthetic-key";
      origin.intercept({ path, method: opts.method ?? "GET" }).reply(302, "", { headers: { location: `${secondBase}/capture` } });
      const before = hits.length;
      await assert.rejects(guardedFetch(`https://synthetic-provider.test${path}`, opts), /Authenticated HTTPS downgrade/);
      assert.equal(hits.length, before);
    }
    origin.intercept({ path: "/anonymous", method: "GET" }).reply(302, "", { headers: { location: `${secondBase}/capture` } });
    assert.equal((await guardedFetch("https://synthetic-provider.test/anonymous")).text(), "ok");
    mocked.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await mocked.close();
  }
});
