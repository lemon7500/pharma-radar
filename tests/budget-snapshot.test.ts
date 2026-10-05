import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetSnapshot } from "@aihot/backend/providers/budget";

const now = new Date("2026-10-05T10:00:00Z");
const ago = (ms: number) => new Date(now.getTime()-ms);
test("budget availability uses rolling windows and does not invent an unlimited service cap", () => {
  assert.equal(budgetSnapshot(undefined, [], now).remaining, null);
  assert.deepEqual(budgetSnapshot({per_minute:2,per_hour:4,per_day:8}, [ago(60_000),ago(30_000)], now),
    {available:true,blockedWindow:null,retryAt:null,remaining:{minute:1,hour:2,day:6}});
});
test("recovery waits for every exhausted window, including caps lowered below current usage", () => {
  const result=budgetSnapshot({per_minute:1,per_hour:2,per_day:3}, [ago(40_000),ago(20_000),ago(10_000)], now);
  assert.equal(result.available,false);
  assert.equal(result.retryAt!.getTime(),ago(40_000).getTime()+86_400_000+1000);
  assert.deepEqual(result.remaining,{minute:0,hour:0,day:0});
});
test("an operator-stopped service stays stopped rather than gaining a fabricated retry date", () => {
  const result=budgetSnapshot({per_minute:0,per_hour:1,per_day:1},[ago(1000)],now);
  assert.equal(result.available,false);assert.equal(result.blockedWindow,'stopped');assert.equal(result.retryAt,null);
});
