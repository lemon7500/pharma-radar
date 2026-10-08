import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBookmarkAvailability } from "../app/lib/bookmark-availability.ts";

const longIds = (count: number) => Array.from({ length: count }, (_, i) => `item${String(i).padStart(3, "0")}${"x".repeat(73)}`);
const requestedIds = (input: string | URL | Request) => new URL(String(input), "http://localhost").searchParams.get("ids")!.split(",");

test("500 maximum-length saved IDs use ten bounded requests with at most two in flight", async () => {
  const ids = longIds(500), paths: string[] = [];
  let active = 0, peak = 0;
  const result = await loadBookmarkAvailability(ids, { fetcher: (async input => {
    paths.push(String(input)); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    const batch = requestedIds(input);
    assert.equal(batch.length, 50);
    assert.ok(String(input).length < 4_200, "URL fits comfortably inside the default 16 KiB HTTP header limit");
    return Response.json(Object.fromEntries(batch.map(id => [id, "public"])));
  }) as typeof fetch });
  assert.equal(paths.length, 10); assert.equal(peak, 2);
  assert.deepEqual(Object.keys(result).sort(), ids.slice().sort());
  assert.ok(Object.values(result).every(value => value === "public"));
});

test("partial failures leave only confirmed states and never turn missing or invalid states into withdrawal", async () => {
  const ids = longIds(200);
  const result = await loadBookmarkAvailability(ids, { fetcher: (async input => {
    const batch = requestedIds(input), first = ids.indexOf(batch[0]!);
    if (first === 50) return new Response("busy", { status: 503 });
    if (first === 100) throw new TypeError("connection lost");
    if (first === 150) return new Response("not JSON");
    return Response.json({ [batch[0]!]: "unavailable", [batch[1]!]: "summary-only", [batch[2]!]: "public", [batch[3]!]: "bad-state", unexpected: "unavailable" });
  }) as typeof fetch });
  assert.deepEqual({ ...result }, { [ids[0]!]: "unavailable", [ids[1]!]: "summary-only", [ids[2]!]: "public" });
  for (const id of ids.slice(3)) assert.equal(result[id], undefined);
});

test("leaving the page cancels both active requests and schedules no later batches", async () => {
  const controller = new AbortController(), signals: AbortSignal[] = [];
  const result = loadBookmarkAvailability(longIds(500), { signal: controller.signal, fetcher: ((_input, init) => {
    const signal = init!.signal!; signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
  }) as typeof fetch });
  assert.equal(signals.length, 2);
  controller.abort();
  assert.deepEqual({ ...await result }, {});
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(signals.length, 2);
});

test("each stalled request has a deadline and its unconfirmed articles stay unset", async () => {
  let aborted = false;
  const result = await loadBookmarkAvailability(longIds(1), { timeoutMs: 10, fetcher: ((_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("Timeout", "AbortError")); }, { once: true });
  })) as typeof fetch });
  assert.equal(aborted, true); assert.deepEqual({ ...result }, {});
});
