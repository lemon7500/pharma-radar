import assert from "node:assert/strict";
import { test } from "node:test";
import { cached } from "@aihot/backend/lib/cache";

test("clearing a cache cannot let an older load erase a newer pending refresh", async () => {
  const resolve: Array<(value: string) => void> = [];
  const cache = cached(() => new Promise<string>(done => resolve.push(done)), { freshMs:60_000,maxStaleMs:60_000 });
  const old = cache.get(); cache.clear(); const current = cache.get();
  assert.equal(resolve.length,2);
  resolve[0]!("old"); assert.equal(await old,"old");
  const joined = cache.get(); assert.equal(resolve.length,2,"the new generation's pending read is still shared");
  resolve[1]!("current");
  assert.equal(await current,"current"); assert.equal(await joined,"current");
  assert.equal(await cache.get(),"current","the older generation never fills the cleared cache");
});
