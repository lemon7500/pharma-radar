import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

test("MCP enforces its byte limit before parsing JSON passed to the SDK", async () => {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  registerMcp(app);
  try {
    const response = await app.inject({ method: "POST", url: "/api/mcp", headers: { "content-type": "application/json", host: "localhost" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "size-check", version: "1" } }, padding: "x".repeat(256 * 1024) }) });
    assert.equal(response.statusCode, 413);
    const normal = await app.inject({ method: "POST", url: "/api/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
      payload: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "size-check", version: "1" } } } });
    assert.equal(normal.statusCode, 200, normal.body);
  } finally { await app.close(); }
});

test("closing the API drains a live MCP subscription before closing HTTP", { timeout: 5000 }, async () => {
  const app = Fastify();
  registerMcp(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      notifications: { toolsListChanged: true },
    } }),
  });
  try {
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /acknowledged/);
    await app.close();
    while (!(await reader.read()).done) { /* consume the SDK's graceful-close result */ }
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});
