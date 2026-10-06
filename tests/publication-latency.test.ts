// Pure database and stored-publication checks; no collectors, models or external services run.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { publicationLatency } from "@aihot/backend/admin/publication-latency";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), SOURCE = `latency-${T}`, SIGNAL = `latency-signal-${T}`, ISOLATED = `latency-isolated-${T}`;
const NOW = new Date("2026-10-06T12:00:00.000Z");
const beforeNow = (minutes:number) => new Date(NOW.getTime()-minutes*60_000);
let n = 0;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  for (const [id, mode] of [[SOURCE,"editorial"],[SIGNAL,"hot_signal"],[ISOLATED,"isolated"]]) {
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${id!},'Publication latency tests','rss','T1',${mode!})`;
  }
});
after(async () => { await stopBoss(); await closeDb(); });

async function isolated(run:(tx:Tx)=>Promise<void>) {
  const rollback = new Error("roll back publication latency fixtures");
  try {
    await sql.begin(async tx => {
      // All invariant files share a throwaway DB. Scope exact statistics inside this rollback only.
      await tx`UPDATE sources SET participation_mode='isolated' WHERE id NOT IN (${SOURCE},${SIGNAL},${ISOLATED})`;
      await run(tx);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

async function article(tx:Tx, options:{source?:string;discoveredAt?:Date;publishedAt?:Date|null;selected?:boolean;relevance?:"pass"|"block";canonicalId?:string;analyzed?:boolean;dateOnly?:boolean} = {}) {
  const id = `latency-${T}-${++n}`, discoveredAt = options.discoveredAt ?? beforeNow(10), publishedAt = options.publishedAt ?? null;
  await tx`INSERT INTO articles(id,source_id,identity_key,url,title,language,body_text,body_status,discovered_at,timeline_at,published_at,processing_state,canonical_article_id,bibliography)
    VALUES(${id},${options.source??SOURCE},${id},${`https://example.org/${id}`},'药学资料时效测试','zh','已有可供阅读的来源摘要。','ok',${discoveredAt},${discoveredAt},${publishedAt},${options.analyzed===false?'new':'analyzed'},${options.canonicalId??null},${tx.json(options.dateOnly?{publishedDate:'2026-10-05'}:{})})`;
  if (options.analyzed !== false) {
    await tx`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category)
      VALUES(${id},1,'rule',${options.relevance??'pass'},'药学资料时效测试','已有可供阅读的来源摘要。',90,${options.selected??false},'paper')`;
  }
  return id;
}

async function projection(tx:Tx, id:string, options:{eligible?:boolean;selected?:boolean;visibility?:"public"|"withdrawn"|"summary-only";visibleAfter?:Date|null;firstPublicAt?:Date|null;indexOnly?:boolean;tracked?:boolean} = {}) {
  await tx`INSERT INTO publications(article_id,source_id,title,summary,channel,url,discovered_at,timeline_at,sort_at,published_at,
      eligible,selected,visibility,visible_after,first_public_at,index_only,first_public_tracking)
    SELECT id,source_id,title,'来源摘要','news',url,discovered_at,timeline_at,timeline_at,published_at,
      ${options.eligible??true},${options.selected??false},${options.visibility??'public'},${options.visibleAfter??null},
      ${options.firstPublicAt??null},${options.indexOnly??false},${options.tracked??true}
    FROM articles WHERE id=${id}`;
}

const firstPublic = async (tx:Tx,id:string) => (await tx<{first_public_at:Date|null}[]>`SELECT first_public_at FROM publications WHERE article_id=${id}`)[0]!.first_public_at;

test("empty monitoring keeps unknown times and quantiles empty", async () => isolated(async tx => {
  assert.deepEqual(await publicationLatency(NOW,tx),{
    waiting:{count:0,recentCount:0,historicalOrUnknownCount:0,oldestDiscoveredAt:null,oldestWaitMinutes:null},
    firstPublic:{sampleCount:0,p50Minutes:null,p95Minutes:null},
    indexOnly:{count:0,recentCount:0,historicalOrUnknownCount:0,oldestFirstPublicAt:null,oldestAgeMinutes:null,untrackedCount:0},
  });
}));

test("first public time records actual initial release and survives republishing", async () => isolated(async tx => {
  const id = await article(tx);
  await publishArticleTx(tx,id,{now:NOW});
  assert.equal((await firstPublic(tx,id))!.getTime(),NOW.getTime());
  await publishArticleTx(tx,id,{now:new Date(NOW.getTime()+3600_000)});
  assert.equal((await firstPublic(tx,id))!.getTime(),NOW.getTime(),"projection refreshes must not replace the observed first release");
}));

test("selected release stays untracked until its visible-after gate opens", async () => isolated(async tx => {
  const id = await article(tx,{selected:true});
  await publishArticleTx(tx,id,{now:NOW});
  const [row] = await tx<{selected:boolean;visible_after:Date;first_public_at:Date|null}[]>`SELECT selected,visible_after,first_public_at FROM publications WHERE article_id=${id}`;
  assert.equal(row!.selected,true);
  assert.ok(row!.visible_after>NOW);
  assert.equal(row!.first_public_at,null);
  assert.equal((await publicationLatency(NOW,tx)).waiting.count,1);
  await publishArticleTx(tx,id,{now:new Date(row!.visible_after.getTime()+1000)});
  assert.equal((await firstPublic(tx,id))!.getTime(),row!.visible_after.getTime(),"the automatic gate's opening is the first available public time");
  assert.equal((await publicationLatency(new Date(row!.visible_after.getTime()+1000),tx)).waiting.count,0);
}));

test("legacy public rows keep unknown first-public time instead of borrowing discovery or update times", async () => isolated(async tx => {
  const id = await article(tx,{discoveredAt:beforeNow(1440)});
  await projection(tx,id,{tracked:false});
  await tx`UPDATE publications SET updated_at=${NOW} WHERE article_id=${id}`;
  await publishArticleTx(tx,id,{now:NOW});
  assert.equal(await firstPublic(tx,id),null);
  const overview = await publicationLatency(NOW,tx);
  assert.equal(overview.waiting.count,0,"a public legacy row is already readable despite its missing timestamp");
  assert.deepEqual(overview.firstPublic,{sampleCount:0,p50Minutes:null,p95Minutes:null});
}));

test("failed basic checks, withdrawn items and canonical aliases do not acquire first-public time", async () => isolated(async tx => {
  const blocked = await article(tx,{relevance:'block'}), withdrawn = await article(tx), representative = await article(tx);
  const alias = await article(tx,{canonicalId:representative}), excluded = await article(tx,{source:ISOLATED});
  await tx`INSERT INTO editorial_overrides(article_id,visibility) VALUES(${withdrawn},'withdrawn')`;
  for (const id of [blocked,withdrawn,alias,excluded]) {
    await publishArticleTx(tx,id,{now:NOW});
    assert.equal(await firstPublic(tx,id),null,id);
  }
}));

test("waiting counts respect editorial scope, current public gates and recent publication dates", async () => isolated(async tx => {
  await article(tx,{analyzed:false,discoveredAt:beforeNow(10),publishedAt:beforeNow(60)});
  await article(tx,{analyzed:false,discoveredAt:beforeNow(30),publishedAt:beforeNow(3*1440)});
  await article(tx,{analyzed:false,discoveredAt:beforeNow(20)});
  await article(tx,{analyzed:false,discoveredAt:beforeNow(40),publishedAt:new Date(NOW.getTime()+3600_000)});
  await article(tx,{analyzed:false,discoveredAt:beforeNow(15),publishedAt:beforeNow(48*60),dateOnly:true});
  const gated = await article(tx,{discoveredAt:beforeNow(25),publishedAt:beforeNow(60)});
  await projection(tx,gated,{selected:true,visibleAfter:new Date(NOW.getTime()+300_000)});
  const unchecked = await article(tx,{discoveredAt:beforeNow(50)});
  await projection(tx,unchecked,{eligible:false});
  const legacy = await article(tx);
  await projection(tx,legacy,{tracked:false});
  const withdrawn = await article(tx,{analyzed:false});
  await tx`INSERT INTO editorial_overrides(article_id,visibility) VALUES(${withdrawn},'withdrawn')`;
  const projectedWithdrawal = await article(tx);
  await projection(tx,projectedWithdrawal,{visibility:'withdrawn'});
  await article(tx,{analyzed:false,canonicalId:legacy});
  await article(tx,{source:SIGNAL,analyzed:false});
  await article(tx,{source:ISOLATED,analyzed:false});
  const rejected = await article(tx,{analyzed:false,discoveredAt:beforeNow(500)});
  await tx`UPDATE articles SET processing_state='blocked' WHERE id=${rejected}`;
  const overview = await publicationLatency(NOW,tx);
  assert.deepEqual(overview.waiting,{count:7,recentCount:3,historicalOrUnknownCount:4,oldestDiscoveredAt:beforeNow(50),oldestWaitMinutes:50});
  assert.equal(overview.firstPublic.sampleCount,0);
  assert.equal(overview.indexOnly.count,0);
}));

test("seven-day discovery-to-public quantiles and index-only age use genuine stored times", async () => isolated(async tx => {
  for (const [age,delay] of [[180,10],[120,20],[60,40]]) {
    const id = await article(tx,{discoveredAt:beforeNow(age!+delay!),publishedAt:beforeNow(1440),dateOnly:true});
    await projection(tx,id,{firstPublicAt:beforeNow(age!),indexOnly:true});
  }
  const old = await article(tx,{discoveredAt:beforeNow(9*1440),publishedAt:beforeNow(10*1440)});
  await projection(tx,old,{firstPublicAt:beforeNow(8*1440),indexOnly:true});
  const legacy = await article(tx,{discoveredAt:beforeNow(1440)});
  await projection(tx,legacy,{tracked:false,indexOnly:true});
  const backwards = await article(tx,{discoveredAt:beforeNow(20)});
  await projection(tx,backwards,{firstPublicAt:beforeNow(30)});
  const future = await article(tx);
  await projection(tx,future,{firstPublicAt:new Date(NOW.getTime()+3600_000)});
  const withdrawn = await article(tx,{discoveredAt:beforeNow(1000)});
  await projection(tx,withdrawn,{firstPublicAt:beforeNow(10),visibility:'withdrawn',indexOnly:true});
  const alias = await article(tx,{discoveredAt:beforeNow(1000),canonicalId:legacy});
  await projection(tx,alias,{firstPublicAt:beforeNow(10),indexOnly:true});
  const signal = await article(tx,{source:SIGNAL,discoveredAt:beforeNow(1000)});
  await projection(tx,signal,{firstPublicAt:beforeNow(10),indexOnly:true});
  const overview = await publicationLatency(NOW,tx);
  assert.equal(overview.firstPublic.sampleCount,3);
  assert.equal(overview.firstPublic.p50Minutes,20);
  assert.ok(Math.abs(overview.firstPublic.p95Minutes!-38)<0.000001);
  assert.deepEqual(overview.indexOnly,{count:5,recentCount:3,historicalOrUnknownCount:2,
    oldestFirstPublicAt:beforeNow(8*1440),oldestAgeMinutes:8*1440,untrackedCount:1});
  assert.equal(overview.waiting.count,0);
}));
