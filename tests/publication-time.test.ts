import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { publicationTime } from "@aihot/contracts/publication-time";

const T = tag(), S = `pub-clock-${T}`, now = new Date("2026-10-01T12:00:00Z");
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${S},${S},'rss','T1','editorial')`; });
after(closeDb);
const base = {channel:"all" as const, category:null, tag:null, q:T, now};
async function record(index:number, date:string|null, publishedAt:Date|null, arrived:Date) {
  const {articleId} = await upsertMaterial({sourceId:S,url:`https://example.org/${T}/${index}`,title:`Pharmacy ${T} ${index}`,bodyText:"A bibliographic research record with sufficient source material for indexing.",publishedAt,discoveredAt:arrived,via:"fetch",bibliography:{doi:null,pmid:null,authors:[],journal:null,publishedDate:date,publicationTypes:[],isPreprint:false}});
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category) VALUES(${articleId},1,'rule','pass',${`药学 ${T} ${index}`},'文献索引',70,false,'paper')`;
  await publishArticle(articleId);
  return articleId;
}
test("bibliographic day wins over arrival and timestamp; timezone boundaries, invalid and future dates remain truthful", () => {
  assert.deepEqual(publicationTime({publishedAt:"2026-09-30T23:35:00Z",sourcePrecision:"time"},now),{date:"2026-10-01",time:"07:35",precision:"time"});
  assert.equal(publicationTime({publishedAt:"2026-09-30T23:35:00Z"},now).time,null,"legacy normalized timestamps alone do not prove source clock precision");
  assert.deepEqual(publicationTime({publishedAt:"2026-09-30T23:35:00Z",research:{bibliography:{publishedDate:"2020-01-02"}}},now),{date:"2020-01-02",time:null,precision:"day"});
  assert.equal(publicationTime({publishedAt:"2026-09-30T00:00:00Z"},now).time,null);
  assert.equal(publicationTime({publishedAt:"2026-09-30T16:00:00Z"},now).time,null);
  for(const date of ["2026-02-30","2026-12-01",null]) assert.deepEqual(publicationTime({publishedAt:null,research:{bibliography:{publishedDate:date}}},now),{date:null,time:null,precision:"unknown"});
  assert.equal(publicationTime({publishedAt:"2027-01-01T12:34:00Z"},now).date,null);
});
test("reader publication ordering, ranges and relevance ties keep late-collected old papers old; legacy timeline stays intact", async () => {
  const old = await record(1,"2010-03-04",null,new Date("2026-10-01T10:00:00Z"));
  const recent = await record(2,"2026-09-30",null,new Date("2026-09-30T10:00:00Z"));
  const exact = await record(3,null,new Date("2026-10-01T01:35:00Z"),new Date("2026-10-01T01:36:00Z"));
  const unknown = await record(4,null,null,new Date("2026-10-01T11:00:00Z"));
  const reader = await loadPool({...base,timeBasis:"publication"});
  assert.deepEqual(reader.items.map(i=>i.id),[exact,recent,old,unknown]);
  assert.equal(reader.items.find(i=>i.id===old)!.publicationTime!.date,"2010-03-04");
  assert.deepEqual((await loadPool({...base,timeBasis:"publication",sort:"oldest"})).items.map(i=>i.id),[old,recent,exact,unknown]);
  assert.deepEqual((await loadPool({...base,timeBasis:"publication",from:"2026-10-01",to:"2026-10-01"})).items.map(i=>i.id),[exact]);
  assert.deepEqual((await loadPool({...base,timeBasis:"publication",tab:"relevance"})).items.map(i=>i.id),[exact,recent,old,unknown]);
  assert.equal((await loadPool(base)).items[0]!.id,unknown);
  assert.notEqual(reader.items.find(i=>i.id===old)!.timelineAt,reader.items.find(i=>i.id===old)!.publicationTime!.date);
  // A malformed legacy metadata date must not make PostgreSQL cast abort the whole page.
  await sql`UPDATE publications SET research=jsonb_set(research,'{bibliography,publishedDate}','"2026-99-99"'::jsonb) WHERE article_id=${old}`;
  assert.equal((await loadPool({...base,timeBasis:"publication"})).total,4);
});
test("publication ordering happens before paging, not within an arrival-ordered page", async () => {
  const ids:string[]=[];
  for(let i=0;i<42;i++) ids.push(await record(100+i,`2025-${String(1+Math.floor(i/28)).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`,null,new Date(now.getTime()-i*60000)));
  const query={...base,q:`${T}`,timeBasis:"publication" as const,from:"2025-01-01",to:"2025-12-31"};
  const first=await loadPool(query),second=await loadPool({...query,page:2});
  assert.equal(first.total,42); assert.equal(first.pageCount,2);
  assert.deepEqual([...first.items,...second.items].map(i=>i.id),ids.reverse());
  assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,42);
});
