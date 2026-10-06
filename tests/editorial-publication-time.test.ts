import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { closeDb, sql } from "@aihot/backend/db";
import { buildScoreInput } from "@aihot/backend/editorial/analyze";
import { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { renderContext } from "@aihot/backend/editorial/writing";
import { editorialPublicationTime, parseSourcePublishedAt, sourcePublicationTime, storedSourcePublicationTime } from "@aihot/backend/editorial/publication-time";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { fetchRss } from "@aihot/backend/sources/rss";
import { jsonListCandidates } from "@aihot/backend/sources/json-list";
import { config } from "@aihot/backend/config";
import type { Bibliography } from "@aihot/contracts/research";

const T = tag(), SOURCE = `editorial-clock-${T}`, now = new Date("2026-10-06T12:00:00Z");
const bibliography = (publishedDate: string | null): Bibliography => ({doi:null,pmid:null,authors:[],journal:"Test Journal",publishedDate,publicationTypes:[],isPreprint:false});
const input = (value: string | null, bib?: Bibliography): AnalyzeInputArticle => {
  const publishedAt = parseSourcePublishedAt(value);
  return { id:T,revision:1,title:"Pharmacy time example",url:"https://example.org/time",author:null,publishedAt,
    discoveredAt:new Date("2026-10-06T01:23:00Z"), sourcePublicationTime:sourcePublicationTime(value,publishedAt), bibliography:bib,
    bodyText:"Source material",excerpt:null,media:[],xPost:null,source:{name:"Clock source",kind:"rss",tier:"T1_5",firstParty:false} };
};
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${SOURCE},${SOURCE},'rss','T1_5','editorial')`; });
after(closeDb);

test("date-only source values stay dates in scoring, structure and writing context", () => {
  const a = input("2026-10-01",bibliography("2026-10-01"));
  assert.equal(editorialPublicationTime(a,now),"2026-10-01");
  assert.match(buildScoreInput(a),/【发布时间（北京时间）】\n2026-10-01\n\n/);
  assert.match(buildMaterial(a),/发表时间：2026-10-01\n/);
  assert.match(renderContext(a),/【发布时间】2026-10-01\n/);
  assert.doesNotMatch(buildScoreInput(a),/08:00|00:00/);
});

test("an explicit timestamp, including real midnight, survives a date-only bibliography", () => {
  const a = input("2026-10-01T00:00:00Z",bibliography("2026-10-01"));
  assert.equal(editorialPublicationTime(a,now),"2026-10-01T08:00:00+08:00");
  assert.match(buildMaterial(a),/发表时间：2026-10-01T08:00:00\+08:00/);
  assert.equal(editorialPublicationTime(input("2026-09-30T16:00:00Z"),now),"2026-10-01T00:00:00+08:00");
  assert.equal(editorialPublicationTime(input("2026-10-01T01:35:12.123Z"),now),"2026-10-01T09:35:12.123+08:00");
});

test("unknown, rejected future and invalid source dates never become arrival dates", () => {
  const a = input(null);
  assert.equal(editorialPublicationTime(a,now),null);
  assert.match(buildScoreInput(a),/【发布时间（北京时间）】\n待确认/);
  assert.match(buildMaterial(a),/发表时间：待确认/);
  assert.doesNotMatch(buildScoreInput(a),/2026-10-06|01:23/);
  assert.equal(editorialPublicationTime(input("2027-01-01T01:35:00Z"),now),null);
  assert.equal(editorialPublicationTime(input(null,bibliography("2026-02-30")),now),null);
  assert.equal(sourcePublicationTime("2026-02-30",new Date("2026-03-02")),null);
  assert.equal(parseSourcePublishedAt("2026-02-30T01:35:00Z"),null);
  assert.equal(editorialPublicationTime(input("2026-02-30"),now),null);
});

test("verified bibliographic dates prevent old papers becoming new; time zone boundaries keep real instants", () => {
  const old = input("2026-09-30T23:35:00Z",bibliography("2020-01-02"));
  assert.equal(editorialPublicationTime(old,now),"2020-01-02");
  delete old.sourcePublicationTime;
  assert.equal(editorialPublicationTime(old,now),"2020-01-02","legacy timestamps cannot override a bibliographic correction either");
  assert.equal(editorialPublicationTime(input("2026-10-01",bibliography("2020-01-02")),now),"2020-01-02");
  assert.equal(editorialPublicationTime(input("2026-09-30T23:35:00Z",bibliography("2026-09-30")),now),"2026-10-01T07:35:00+08:00（书目日期：2026-09-30）");
});

test("old sources without bibliography or precision keep a conservative midnight fallback", () => {
  for (const [value,expected] of [["2026-10-01T00:00:00Z","2026-10-01"],["2026-09-30T16:00:00Z","2026-10-01"],["2026-10-01T01:35:00Z","2026-10-01T09:35:00+08:00"]]) {
    const a = input(value!); delete a.sourcePublicationTime;
    assert.equal(editorialPublicationTime(a,now),expected);
  }
  const a = input("2026-10-01T00:00:00Z",bibliography("2020-01-02")); delete a.sourcePublicationTime;
  assert.equal(editorialPublicationTime(a,now),"2020-01-02");
});

test("source metadata must match accepted time; JSON epoch and yyyymmdd precision remain distinct", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const day = sourcePublicationTime("20261001",at,"yyyymmdd");
  assert.equal(day?.precision,"day");
  const epoch = sourcePublicationTime(at.getTime(),at,"epoch_ms");
  assert.equal(epoch?.precision,"time");
  assert.equal(storedSourcePublicationTime({...day,at:"2026-09-01T00:00:00.000Z"},at),null);
  assert.equal(storedSourcePublicationTime({...day,value:"2026-10-02"},at),null);
});

test("production analysis loads source precision and recapture fills only matching same-source metadata", async () => {
  const publishedAt = new Date("2026-10-01T00:00:00Z");
  const material = {sourceId:SOURCE,url:`https://example.org/${T}`,title:"Pharmacy clock record",bodyText:"Source body unchanged across recapture",publishedAt,via:"fetch" as const,raw:{guid:"clock-guid"}};
  const original = await upsertMaterial(material);
  assert.equal(editorialPublicationTime((await loadAnalyzeInput(original.articleId))!,now),"2026-10-01");
  const precise = sourcePublicationTime("2026-10-01T00:00:00Z",publishedAt);
  const recaptured = await upsertMaterial({...material,raw:{publicationTime:precise}});
  assert.equal(recaptured.revised,false);
  const loaded = (await loadAnalyzeInput(original.articleId))!;
  assert.equal(editorialPublicationTime(loaded,now),"2026-10-01T08:00:00+08:00");
  const [row] = await sql<{revision:number;raw:Record<string,unknown>}[]>`SELECT revision,raw FROM articles WHERE id=${original.articleId}`;
  assert.equal(row!.revision,1); assert.equal(row!.raw.guid,"clock-guid");
  await upsertMaterial({...material,raw:{publicationTime:sourcePublicationTime("2026-10-01",publishedAt)}});
  assert.equal(editorialPublicationTime((await loadAnalyzeInput(original.articleId))!,now),"2026-10-01T08:00:00+08:00","a later date-only feed cannot erase previously verified clock precision");
  const changed = new Date("2026-10-02T00:00:00Z");
  await upsertMaterial({...material,publishedAt:changed,raw:{publicationTime:sourcePublicationTime("2026-10-02",changed)}});
  assert.equal(editorialPublicationTime((await loadAnalyzeInput(original.articleId))!,now),"2026-10-01T08:00:00+08:00","a different source claim cannot overwrite accepted source-time precision");
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason) VALUES(${original.articleId},${sql.json({researchBibliography:bibliography("2020-01-02")} as never)},'Isolated test bibliographic correction')`;
  assert.equal(editorialPublicationTime((await loadAnalyzeInput(original.articleId))!,now),"2020-01-02","analysis uses the same audited bibliographic override as publication");
});

test("RSS and JSON retain source precision and reject impossible ISO dates before persistence", async () => {
  const values = ["2026-10-01","2026-10-01T00:00:00Z","2026-02-30",""];
  const server = http.createServer((_req,res) => {
    res.writeHead(200,{"content-type":"application/rss+xml"});
    res.end(`<rss version="2.0"><channel>${values.map((value,i)=>`<item><title>Clock ${i}</title><link>https://example.org/clock/${i}</link><pubDate>${value}</pubDate></item>`).join("")}</channel></rss>`);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    const read = await fetchRss({id:SOURCE,config:{feedUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/feed`},participation_mode:"editorial",cursor:null} as never);
    const source = {config:{itemsPath:"items",titlePaths:["title"],urlTemplate:"https://example.org/clock/{id}",publishedAtPath:"date"}} as never;
    const json = jsonListCandidates(source,{items:values.map((date,i)=>({id:i,title:`Clock ${i}`,date}))});
    for (const candidates of [read.candidates,json]) {
      assert.equal((candidates[0]!.raw as {publicationTime:{precision:string}}).publicationTime.precision,"day");
      assert.equal((candidates[1]!.raw as {publicationTime:{precision:string}}).publicationTime.precision,"time");
      assert.equal(candidates[2]!.publishedAt,null);
      assert.equal(candidates[3]!.publishedAt,null);
    }
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
