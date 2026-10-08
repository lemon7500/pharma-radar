import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader(stars: unknown[] = []) {
  const values = new Map<string, string>([["aihot-starred-items", JSON.stringify(stars)]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  // A fresh module has the same empty snapshot cache as a newly opened browser tab.
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values };
}

const invalidDates = ["not-a-date", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;

test("import normalizes invalid bookmark dates before persisting without dropping bookmarks", async () => {
  const { state, values } = await reader();
  const before = Date.now();
  const result = state.importBundle(JSON.stringify({ version: 1, starred: invalidDates.map((value, i) => ({
    id: `item-${i}`, title: `Title ${i}`, savedAt: value, publishedAt: value,
  })) }));
  assert.equal(result.starredAdded, invalidDates.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalidDates.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("existing invalid dates are readable, exportable and removable after reopening the page", async () => {
  const { state } = await reader([{ id: "old", title: "Keep this bookmark", savedAt: "broken", publishedAt: "broken" }]);
  const stars = state.getStarred();
  assert.equal(stars.length, 1);
  assert.equal(stars[0]!.title, "Keep this bookmark");
  assert.equal(stars[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(stars[0]!.savedAt));
  assert.strictEqual(state.getStarred(), stars, "normalization preserves stable React snapshots");
  assert.deepEqual(state.exportBundle().starred, stars);
  state.removeStar("old");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates and existing bookmarks survive import unchanged", async () => {
  const item = { id: "valid", title: "Original title", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([item]);
  const result = state.importBundle(JSON.stringify({ version: 1, starred: [{ ...item, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(result.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, item.title);
  assert.equal(saved!.savedAt, item.savedAt);
  assert.equal(saved!.publishedAt, item.publishedAt);
});

test("direct bookmarks retain safe clock snapshots and export them without changing local data version", async () => {
  const {state}=await reader();
  const time={date:"2026-10-01",time:"09:35",precision:"time" as const};
  state.toggleStar({id:"clock",title:"Source record",summary:null,sourceName:"Source",publishedAt:"2026-10-01T01:35:00Z",publicationTime:time,score:null,aiSelected:false});
  assert.deepEqual(state.getStarred()[0]!.publicationTime,time);
  const bundle=state.exportBundle();
  assert.equal(bundle.version,1); assert.equal(state.KEYS.starred,"aihot-starred-items");
  assert.deepEqual(bundle.starred[0]!.publicationTime,time);
});

test("imported clock declarations are downgraded while unknown and invalid precision never become source clocks", async () => {
  const {state}=await reader();
  const records=[
    {id:"declared",publicationTime:{date:"2026-10-01",time:"09:35",precision:"time",privateEvidence:"PRIVATE"}},
    {id:"unknown",publicationTime:{date:null,time:null,precision:"unknown"}},
    {id:"false-unknown",publicationTime:{date:"2026-10-01",time:"09:35",precision:"unknown"}},
    {id:"bad-clock",publicationTime:{date:"2026-10-01",time:"25:35",precision:"time"}},
    {id:"bad-day",publicationTime:{date:"2026-02-30",time:"09:35",precision:"time"}},
  ].map(v=>({...v,title:v.id,savedAt:"2026-10-02T12:00:00Z",publishedAt:"2026-10-01T01:35:00Z"}));
  const report=state.importBundle(JSON.stringify({version:1,starred:records}));
  assert.equal(report.starredAdded,5);
  const saved=state.getStarred();
  assert.deepEqual(saved.find(v=>v.id==="declared")!.publicationTime,{date:"2026-10-01",time:null,precision:"day"});
  assert.deepEqual(saved.find(v=>v.id==="unknown")!.publicationTime,{date:null,time:null,precision:"unknown"});
  for(const id of ["false-unknown","bad-clock","bad-day"]) assert.equal(saved.find(v=>v.id===id)!.publicationTime,undefined);
  assert.doesNotMatch(JSON.stringify(state.exportBundle()),/PRIVATE|privateEvidence/);
});
