import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
let instance = 0;
const bookmark = { id:"saved", title:"Retain the old bookmark", summary:null, sourceName:"Source", savedAt:"2026-10-01T00:00:00Z", publishedAt:null, score:null, aiSelected:false };

async function reader(mode: "quota" | "denied" | "ok" = "quota") {
  const values = new Map<string,string>([["aihot-starred-items",JSON.stringify([bookmark])],["aihot-read-items",JSON.stringify(["already-read"])]]);
  const localStorage = {
    getItem: (key:string) => values.get(key) ?? null,
    setItem: (key:string,value:string) => { if (mode === "quota") throw new DOMException("full", "QuotaExceededError"); values.set(key,value); },
    removeItem: (key:string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis,"window",{configurable:true,value:{get localStorage() { if(mode === "denied") throw new DOMException("blocked", "SecurityError"); return localStorage; }}});
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?failure=${instance++}`);
  return {state,values};
}

test("quota failures never report a saved toggle or remove an existing bookmark", async () => {
  const {state,values} = await reader();
  const snapshot = state.getStarred();
  assert.equal(state.toggleStar({...bookmark,id:"new"}),null);
  assert.equal(state.toggleStar(bookmark),null);
  assert.equal(state.removeStar(bookmark.id),false);
  assert.strictEqual(state.getStarred(),snapshot,"failed writes must preserve the readable snapshot");
  assert.deepEqual(JSON.parse(values.get(state.KEYS.starred)!),[bookmark]);
});

test("failed read writes retain previous marks and return a failure readers can see", async () => {
  const {state,values} = await reader();
  const snapshot = state.getReadIds();
  assert.equal(state.markRead("new-read"),false);
  assert.equal(state.markRead("already-read"),true);
  assert.strictEqual(state.getReadIds(),snapshot);
  assert.deepEqual(JSON.parse(values.get(state.KEYS.read)!),["already-read"]);
});

test("denied storage returns failures without throwing or pretending data persisted", async () => {
  const {state} = await reader("denied");
  assert.equal(state.toggleStar(bookmark),null);
  assert.equal(state.removeStar(bookmark.id),false);
  assert.equal(state.markRead(bookmark.id),false);
  assert.deepEqual(state.getStarred(),[]);
  assert.deepEqual(state.getReadIds(),[]);
});

test("successful reader changes keep the old storage keys, formats and toggle return values", async () => {
  const {state,values} = await reader("ok");
  assert.equal(state.toggleStar({...bookmark,id:"new"}),true);
  assert.equal(state.toggleStar({ ...bookmark,id:"new" }),false);
  assert.equal(state.markRead("new-read"),true);
  assert.equal(state.removeStar(bookmark.id),true);
  assert.deepEqual(JSON.parse(values.get("aihot-starred-items")!),[]);
  assert.deepEqual(JSON.parse(values.get("aihot-read-items")!),["new-read","already-read"]);
});

test("invalid imports and an unwritable import keep existing local data", async () => {
  const {state,values} = await reader();
  const before = [...values];
  for (const invalid of ["{", "null", JSON.stringify({version:2}), "x".repeat(state.IMPORT_MAX_CHARS+1)]) assert.throws(() => state.importBundle(invalid));
  assert.throws(() => state.importBundle(JSON.stringify({version:1,starred:[{...bookmark,id:"incoming"}]})),/没有导入任何内容/);
  assert.deepEqual([...values],before);
  assert.deepEqual(state.getStarred(),[bookmark]);
});

test("partial import failure reports saved bookmarks and the unsaved read marks separately", async () => {
  const values = new Map<string,string>();
  Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{
    getItem:(key:string) => values.get(key) ?? null,
    setItem:(key:string,value:string) => { if(key === "aihot-read-items") throw new DOMException("full","QuotaExceededError"); values.set(key,value); },
    removeItem:(key:string) => { values.delete(key); },
  }}});
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?failure=${instance++}`);
  const result = state.importBundle(JSON.stringify({version:1,starred:[bookmark],read:["saved"]}));
  assert.equal(result.starredAdded,1);
  assert.equal(result.readAdded,0);
  assert.equal(result.readFailed,true);
  assert.equal(state.getStarred()[0]!.id,"saved");
  assert.deepEqual(state.getReadIds(),[]);
});
