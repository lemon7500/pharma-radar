import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sourcePublicationTime } from "@aihot/backend/editorial/publication-time";
import { validateResearchExtraction } from "@aihot/backend/research/profile";
import { publicPublicationTime } from "@aihot/backend/publication/time";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedSnapshot, selectedChanges } from "@aihot/backend/publication/v1";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadPool } from "@aihot/backend/publication/pool";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag(), S = `public-time-${T}`, now = new Date();
const app = await buildApp();
let apiAddress:string;
const instant = new Date(now.getTime() - 3600000);
const day = beijingDate(instant);
const exact = sourcePublicationTime(instant.toISOString(), instant)!;
before(async () => {
  // Other files leave pending releases. Clamp to this suite's fixed clock, not SQL now():
  // a later database clock would still block the entire ledger at effectiveWatermark(now).
  await sql`UPDATE selected_ledger SET visible_at=${now} WHERE visible_at>${now}`;
  const [pending]=await sql`SELECT count(*)::int AS n FROM selected_ledger WHERE visible_at>${now}`;
  assert.equal(pending!.n,0,"prior test releases cannot block this suite's fixed snapshot clock");
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${S},${S},'rss','T1','editorial','2100-01-01')`;
  apiAddress=await app.listen({host:"127.0.0.1",port:0});
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function record(key: string, publishedAt: Date | null, publishedDate: string | null, original?: unknown, selected = false, explicitId?:string) {
  const bibliography={ doi:null,pmid:null,authors:[],journal:null,publishedDate,publicationTypes:[],isPreprint:false };
  const object="We studied candidate molecules for pharmacological discovery.";
  const methods="We tested the candidates in cultured cells in vitro.";
  const results="Treatment reduced cell viability compared with the control.";
  const body=`${object} ${methods} ${results} ` + "The source abstract provides pharmacological screening data and study methods sufficient for a reading note. ".repeat(2);
  const u = await upsertMaterial({ sourceId:S, url:`https://example.org/${T}/${key}`, title:`药学资料 ${key} ${T}`,
    publishedAt, discoveredAt:now, via:"fetch", bodyText:body,
    raw:{ publicationTime:original, privateSourceToken:"PRIVATE-SOURCE-TOKEN" },
    bibliography,...(explicitId ? {id:explicitId} : {}) });
  if(selected) {
    const out=validateResearchExtraction({claims:{object:{text:"candidate molecules",quote:object},methods:{text:"cultured cells in vitro",quote:methods},results:{text:"reduced cell viability",quote:results}}},{title:`药学资料 ${key} ${T}`,bodyText:body,bibliography});
    assert.equal(out.profile.status,"ready");
    await sql`UPDATE articles SET research_profile=${sql.json(out.profile as never)},research_support=${sql.json(out.support)},research_revision=revision WHERE id=${u.articleId}`;
  }
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category)
    VALUES(${u.articleId},1,'rule','pass',${`药学资料 ${key} ${T}`},'材料范围说明',60,${selected},${selected ? "tip" : null})`;
  await publishArticle(u.articleId,{ now,releasedAt:new Date(now.getTime()-60000) });
  return u.articleId;
}
const get = async (url:string) => { const r=await app.inject({method:"GET",url}); assert.equal(r.statusCode,200,r.body); return r.body; };
const publicOnly = (value:unknown) => assert.doesNotMatch(JSON.stringify(value),/privateSourceToken|PRIVATE-SOURCE-TOKEN|source_publication_time|"raw"|"value"|"at"/);

test("source-aware public time preserves proved clocks, rejects false precision and never splices a corrected day", () => {
  assert.deepEqual(publicPublicationTime({published_at:instant,publication_date:day,source_publication_time:exact},now),{date:day,time:beijingTime(instant),precision:"time"});
  assert.deepEqual(publicPublicationTime({published_at:instant,publication_date:"2010-03-04",source_publication_time:exact},now),{date:"2010-03-04",time:null,precision:"day"});
  for(const source of [undefined,{...exact,value:"2026-02-30T09:35:00Z"},{...exact,at:new Date(instant.getTime()-1000).toISOString()},{...exact,value:day,precision:"time"}]) {
    assert.equal(publicPublicationTime({published_at:instant,publication_date:day,source_publication_time:source},now).time,null);
  }
  const midnight=new Date("2026-10-01T16:00:00Z");
  assert.deepEqual(publicPublicationTime({published_at:midnight,publication_date:"2026-10-02",source_publication_time:sourcePublicationTime("2026-10-02T00:00:00+08:00",midnight)},now),{date:"2026-10-02",time:"00:00",precision:"time"});
  assert.deepEqual(publicPublicationTime({published_at:null},now),{date:null,time:null,precision:"unknown"});
});

test("site, v1, Markdown, RSS and MCP share source precision without leaking private date evidence", async () => {
  const ids = {
    exact:await record("exact",instant,day,exact,true),
    date:await record("date",new Date(day),day,sourcePublicationTime(day,new Date(day)),true),
    old:await record("old",null,"2010-03-04",undefined,true),
    unknown:await record("unknown",null,null,undefined,true),
  };
  const expected = {
    exact:{date:day,time:beijingTime(instant),precision:"time"}, date:{date:day,time:null,precision:"day"},
    old:{date:"2010-03-04",time:null,precision:"day"},unknown:{date:null,time:null,precision:"unknown"},
  };
  const api = JSON.parse(await get(`/api/v1/items?mode=all&window=7d&limit=100&q=${T}`));
  const xml=await get("/feed/category/tip.xml"), $=cheerio.load(xml,{xml:true});
  assert.ok(xml.includes('xmlns:dc="http://purl.org/dc/elements/1.1/"'));
  for(const [kind,id] of Object.entries(ids)) {
    const site=JSON.parse(await get(`/api/site/items/${id}`));
    const v1=api.items.find((item:{id:string})=>item.id===id);
    assert.ok(v1,`${kind} retained by compatible legacy v1 window`);
    assert.deepEqual(site.publicationTime,expected[kind as keyof typeof expected]);
    assert.deepEqual(v1.publicationTime,site.publicationTime);
    publicOnly(site); publicOnly(v1);
    assert.equal(v1.publishedAt,site.publishedAt,"historical publishedAt stays compatible");
    assert.equal(v1.discoveredAt,site.discoveredAt,"historical discoveredAt stays compatible");
    const md=await get(`/items/${id}/markdown`);
    const stamp=kind==="unknown" ? "发表时间待确认" : kind==="old" ? "2010-03-04" : kind==="exact" ? `${day} ${beijingTime(instant)} (UTC+08:00)` : day;
    assert.ok(md.includes(`- 发表时间：${stamp}\n`));
    assert.ok(md.includes(`- 本站收录时间：${now.toISOString()}`));
    assert.doesNotMatch(md,/PRIVATE-SOURCE-TOKEN|source_publication_time/);
    const entry=$("item").filter((_i,e)=>$(e).find("guid").text()===id);
    assert.equal(entry.length,1,`${kind} retained by compatible legacy RSS window`);
    if(kind==="exact") assert.equal(entry.find("pubDate").text(),instant.toUTCString());
    else assert.equal(entry.find("pubDate").length,0,"unsupported clocks never enter RFC822 pubDate");
    assert.equal(entry.find("dc\\:date").text(),kind==="unknown" ? "" : kind==="old" ? "2010-03-04" : kind==="exact" ? instant.toISOString() : day);
    assert.ok(entry.find("description").text().includes(stamp));
  }
  const client=new Client({name:"public-time-test",version:"1.0.0"});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${apiAddress}/api/mcp`)));
    const response=await client.callTool({name:MCP_TOOL_NAMES.search,arguments:{q:T,category:"tip",window:"7d",limit:30}});
    const text=(response.content as {type:string;text?:string}[]).find(v=>v.type==="text")!.text!;
    assert.ok(text.includes("发表时间：2010-03-04"));
    assert.ok(text.includes("发表时间：发表时间待确认"));
    assert.ok(text.includes(`发表时间：${day} ${beijingTime(instant)} (UTC+08:00)`));
    publicOnly(response.structuredContent);
    const structured=response.structuredContent as {items:{id:string;publicationTime:unknown}[]};
    for(const [kind,id] of Object.entries(ids)) assert.deepEqual(structured.items.find(v=>v.id===id)?.publicationTime,expected[kind as keyof typeof expected]);
  } finally { await client.close(); }
});

test("legacy selected snapshots and ordered repeated changes gain safe time while preserving every payload version", async () => {
  const before=await selectedSnapshot({limit:1000,page:null},now);
  const id=await record("legacy-selected",null,"2010-03-04",undefined,true);
  const titles=[`药学资料 legacy-selected ${T}`,`修订一 ${T}`,`修订二 ${T}`];
  for(const title of titles.slice(1)) {
    await sql`UPDATE analyses SET title_zh=${title} WHERE article_id=${id}`;
    await publishArticle(id,{now,releasedAt:new Date(now.getTime()-60000)});
  }
  await sql`UPDATE selected_ledger SET payload=payload-'publicationTime' WHERE article_id=${id} AND op='upsert'`;
  const safe={date:"2010-03-04",time:null,precision:"day"};
  for(const fields of ["default","minimal"] as const) {
    const snapshot=await selectedSnapshot({fields,limit:1000,page:null},now);
    assert.deepEqual(snapshot.items.find(v=>v.id===id)?.publicationTime,safe);
    publicOnly(snapshot);
  }
  const changes=await selectedChanges({cursor:before.cursor,limit:1000},now);
  const versions=changes.changes.filter(v=>v.op==="upsert" && v.item.id===id);
  assert.deepEqual(versions.map(v=>v.op==="upsert" ? v.item.title : null),titles);
  for(const version of versions) if(version.op==="upsert") assert.deepEqual(version.item.publicationTime,safe);
  publicOnly(changes);
});

test("story API and MCP retain legacy chronology while displaying the same supported publication dates", async () => {
  const old=await record("story-old",null,"2010-03-04"),unknown=await record("story-unknown",null,null);
  const publicId=randomUUID();
  const [story]=await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${publicId},${`时间故事 ${T}`},${now},${now}) RETURNING id`;
  const [fact]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`time-fact-${publicId}`},${story.id},'共同事实') RETURNING id`;
  for(const id of [old,unknown]) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact.id},${id},'report')`;
  const site=JSON.parse(await get(`/api/site/stories/${publicId}`));
  const v1=JSON.parse(await get(`/api/v1/stories/${publicId}`)).story;
  for(const [id,safe] of [[old,{date:"2010-03-04",time:null,precision:"day"}],[unknown,{date:null,time:null,precision:"unknown"}]] as const) {
    const report=site.timeline.find((r:{id:string})=>r.id===id),apiReport=v1.reports.find((r:{id:string})=>r.id===id);
    assert.equal(report.publishedAt,now.toISOString(),"legacy chronology timestamp is preserved");
    assert.equal(apiReport.publishedAt,report.publishedAt);
    assert.deepEqual(report.publicationTime,safe); assert.deepEqual(apiReport.publicationTime,safe);
  }
  publicOnly(site); publicOnly(v1);
  const client=new Client({name:"story-public-time-test",version:"1.0.0"});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${apiAddress}/api/mcp`)));
    const result=await client.callTool({name:MCP_TOOL_NAMES.story,arguments:{public_id:publicId}});
    const text=(result.content as {type:string;text?:string}[]).find(v=>v.type==="text")!.text!;
    assert.match(text,/2010-03-04 · 发表/); assert.match(text,/发表时间待确认 · 发表/);
    publicOnly(result.structuredContent);
  } finally { await client.close(); }
});

test("publication sorting uses proved same-day clocks before paging and rejects invalid or extreme raw casts", async () => {
  const date="2026-10-01", early=new Date(`${date}T09:35:00+08:00`), late=new Date(`${date}T10:00:00+08:00`), epoch=new Date(`${date}T10:15:00+08:00`);
  const key=`clock-sort-${T}`;
  const earlyId=await record(`${key}-early`,early,date,sourcePublicationTime(early.toISOString(),early),false,`clock-${T}-z`);
  const lateId=await record(`${key}-late`,late,date,sourcePublicationTime(late.toISOString(),late),false,`clock-${T}-a`);
  const epochId=await record(`${key}-epoch`,epoch,date,sourcePublicationTime(String(epoch.getTime()),epoch,"epoch_ms"));
  const unproved=await record(`${key}-legacy`,new Date(`${date}T23:30:00+08:00`),date);
  const noBibliography=await record(`${key}-legacy-no-bibliography`,new Date(`${date}T23:45:00+08:00`),null);
  const bad=await record(`${key}-invalid`,late,date,{at:late.toISOString(),precision:"time",value:"2026-02-30T10:00:00+08:00"});
  const extreme=await record(`${key}-extreme`,late,date,{at:late.toISOString(),precision:"time",value:"1e99",unit:"epoch_s"});
  const badUnit=await record(`${key}-invalid-unit`,late,date,{at:late.toISOString(),precision:"time",value:late.toISOString(),unit:"yyyymmdd"});
  const claimed=await record(`${key}-false-precision`,new Date(date),date,{at:new Date(date).toISOString(),precision:"time",value:date});
  const conflicting=await record(`${key}-audited-date`,late,"2010-03-04",sourcePublicationTime(late.toISOString(),late));
  const query={channel:"all" as const,category:null,tag:null,q:key,timeBasis:"publication" as const,now};
  const descending=await loadPool(query);
  assert.deepEqual(descending.items.slice(0,3).map(v=>v.id),[epochId,lateId,earlyId],"source clocks take precedence over the deliberately opposite ID order");
  assert.equal(descending.items.at(-1)!.id,conflicting,"audited bibliographic date wins over a later accepted instant");
  for(const id of [unproved,noBibliography,bad,extreme,badUnit,claimed]) assert.equal(descending.items.find(v=>v.id===id)!.publicationTime!.time,null);
  const ascending=await loadPool({...query,sort:"oldest"});
  assert.equal(ascending.items[0]!.id,conflicting);
  assert.deepEqual(ascending.items.slice(-3).map(v=>v.id),[earlyId,lateId,epochId]);
  // Put enough date-only rows on the same day to cross a page boundary. Their IDs must not displace proved clocks.
  for(let i=0;i<42;i++) await record(`${key}-day-${i}`,new Date(date),date,sourcePublicationTime(date,new Date(date)),false,`clock-${T}-zz-${String(i).padStart(2,"0")}`);
  const first=await loadPool(query),second=await loadPool({...query,page:2});
  assert.equal(first.total,52); assert.equal(first.pageCount,2);
  assert.deepEqual(first.items.slice(0,3).map(v=>v.id),[epochId,lateId,earlyId]);
  assert.equal(new Set([...first.items,...second.items].map(v=>v.id)).size,52);
});
