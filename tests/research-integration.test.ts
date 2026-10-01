import {tag,stub} from './setup.ts';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {normalizeBibliography,validateResearchExtraction} from '@aihot/backend/research/profile';
import {publishArticle} from '@aihot/backend/publication/publish';
import {loadPool} from '@aihot/backend/publication/pool';
import {loadItemDetail,exportMarkdown} from '@aihot/backend/publication/detail';
import {loadItemShare} from '@aihot/backend/publication/og';
import {overrideFields,rerun,setVisibility} from '@aihot/backend/admin/content';
import {reconcileResearchDoi} from '@aihot/backend/research/enrich';
import {claimResearchBackfill,backfillResearch} from '@aihot/backend/research/backfill';
import {stopBoss} from '@aihot/backend/jobs/queue';
const T=tag(),S=`research-${T}`,S2=`research-other-${T}`;
const body='We used machine learning and virtual screening for natural products. We tested compounds in vitro with cultured cells. Our results showed activity reduced by 25 percent. Further animal and clinical studies are required.';
const bib=normalizeBibliography({doi:`10.1234/${T}`,authors:['A Author'],journal:'Test Journal',publishedDate:'2026-09-20',publicationTypes:['Journal Article']});
before(async()=>{for(const source of [S,S2]) await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},${source},'rss','T1','editorial')`;});
after(async()=>{await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE source_id IN (${S},${S2})`;await stopBoss();await closeDb();});
async function record(n:number,doi:string|null=null) {
 const bibliography={...bib,doi:doi||`10.1234/${T}-${n}`};
 const {articleId}=await upsertMaterial({sourceId:S,url:`https://example.org/${T}/${n}`,title:`Machine learning for natural product drug discovery ${n}`,bodyText:body,bibliography,bodyStatus:'ok',via:'fetch',discoveredAt:new Date(Date.now()-n*60000)});
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,category) VALUES(${articleId},1,'rule','pass',${`药学研究样本 ${T} ${n}`},'研究摘要',70,false,'paper')`;
 const {profile,support}=validateResearchExtraction({evidenceStages:[{value:'computational',quote:'We used machine learning and virtual screening'},{value:'in-vitro',quote:'We tested compounds in vitro with cultured cells'}],claims:{results:{text:'活性降低25%。',quote:'activity reduced by 25 percent'}}},{title:'Machine learning for natural product drug discovery',bodyText:body,bibliography});
 await sql`UPDATE articles SET research_profile=${sql.json(profile as never)},research_support=${sql.json(support)},research_revision=revision WHERE id=${articleId}`;
 await publishArticle(articleId);return articleId;
}
test('combined filters, search metadata and sort include crossing papers without exposing support quotes',async()=>{
 const first=await record(1),second=await record(2);
 const filters={channel:'all' as const,category:null,tag:null,q:T,area:['discovery'] as const,focus:['ai-pharma','tcm-natural-products'] as const,evidence:['in-vitro'] as const};
 const result=await loadPool({...filters,area:[...filters.area],focus:[...filters.focus],evidence:[...filters.evidence],sort:'oldest'});
 assert.equal(result.total,2);assert.deepEqual(result.items.map(i=>i.id),[second,first]);assert.deepEqual(result.filters.evidence,['in-vitro']);
 assert.ok(result.items.every(i=>i.research?.foci.length===2));assert.ok(!JSON.stringify(result).includes('quote'));
 const empty=await loadPool({...filters,area:[...filters.area],focus:[...filters.focus],evidence:['clinical']});assert.equal(empty.total,0);
 const byAuthor=await loadPool({channel:'all',category:null,tag:null,q:`A Author ${T}`});assert.equal(byAuthor.total,2);
 const detail=await loadItemDetail(first);assert.equal(detail.kind,'found');if(detail.kind==='found') assert.equal(detail.detail.research?.bibliography.journal,'Test Journal');
});
test('own DOI deduplicates across sources and keeps discoveries; existing aliases keep their detail URL',async()=>{
 const original=await record(3,`10.1234/${T}-dedup`);
 const discovered=await upsertMaterial({sourceId:S2,url:`https://other.example.org/${T}`,title:'Second source',bibliography:{...bib,doi:`10.1234/${T}-dedup`},via:'fetch'});
 assert.equal(discovered.articleId,original);assert.equal(discovered.created,false);
 const sources=await sql`SELECT source_url FROM article_discoveries WHERE article_id=${original}`;assert.equal(sources.length,2);
 const alias=await record(4);await sql`UPDATE articles SET bibliography=${sql.json({...bib,doi:`10.1234/${T}-dedup`} as never)} WHERE id=${alias}`;
 const affected=await reconcileResearchDoi(alias);assert.equal(affected.length,2);for(const id of affected) await publishArticle(id);
 const duplicates=await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${affected}) AND eligible`;assert.equal(duplicates[0]!.n,1);
 assert.equal((await loadItemDetail(original)).kind,'found');assert.equal((await loadItemDetail(alias)).kind,'found');
 const [representative]=await sql`SELECT article_id FROM publications WHERE article_id=ANY(${affected}) AND eligible`;
 await setVisibility(representative!.article_id,{visibility:'withdrawn',version:0,reason:'撤回来源测试'},'test-editor');
 const [remaining]=await sql`SELECT article_id FROM publications WHERE article_id=ANY(${affected}) AND eligible AND visibility='public'`;
 assert.ok(remaining);assert.notEqual(remaining!.article_id,representative!.article_id);
});
test('share images and exported reading notes hide unverified legacy claims and retain supported research',async()=>{
 const id=await record(7);
 const note=await exportMarkdown(id);assert.ok(note);assert.match(note.body,/核心结果[\s\S]*活性降低25%/);assert.match(note.body,/DOI：10\.1234/);assert.match(note.body,/研究局限[\s\S]*未提供足够依据/);
 assert.ok(!note.body.includes('quote'));
 const share=await loadItemShare(id);assert.equal(share!.summary,'活性降低25%。');assert.equal(share!.researchKicker,'研究资料');
 await sql`UPDATE articles SET body_text='References: 10.1234/a 10.1234/b 10.1234/c',revision=revision+1 WHERE id=${id}`;
 await sql`UPDATE analyses SET summary_zh='未经证实的临床疗效',category='clinical',tags=ARRAY['临床试验','药理机制'] WHERE article_id=${id}`;
 await publishArticle(id);
 const pendingShare=await loadItemShare(id);assert.match(pendingShare!.summary!,/待确认/);assert.ok(!pendingShare!.summary!.includes('临床疗效'));assert.equal(pendingShare!.researchKicker,'研究资料');
 const detail=await loadItemDetail(id);assert.equal(detail.kind,'found');if(detail.kind==='found'){assert.ok(!detail.detail.tags.includes('临床试验'));assert.ok(detail.detail.tags.includes('药理机制'));assert.equal(detail.detail.category,'clinical');}
 const pendingNote=await exportMarkdown(id);assert.ok(pendingNote);assert.match(pendingNote.body,/暂不生成深入导读/);assert.ok(!pendingNote.body.includes('活性降低25')&&!pendingNote.body.includes('未经证实的临床疗效'));
 const quote='We enrolled patients in a randomized phase II clinical trial.';
 const clinicalBody=quote+' Our study compared the trial groups using prespecified clinical endpoints and reported the trial design.';
 const supported=validateResearchExtraction({evidenceStages:[{value:'clinical',quote}],clinicalPhase:{value:'II',quote},claims:{question:{text:'开展随机II期临床试验。',quote}}},{title:'Clinical trial',bodyText:clinicalBody,bibliography:bib});
 await sql`UPDATE articles SET body_text=${clinicalBody},revision=revision+1,research_profile=${sql.json(supported.profile as never)},research_support=${sql.json(supported.support)},research_revision=revision+1 WHERE id=${id}`;
 await publishArticle(id);const verified=await loadItemDetail(id);assert.equal(verified.kind,'found');if(verified.kind==='found'){assert.ok(verified.detail.tags.includes('临床试验'));assert.equal(verified.detail.research?.clinicalPhase,'II');}
});
test('admin rejects unsupported research, audits verified corrections and preserves them on republish',async()=>{
 const id=await record(5);
 await assert.rejects(overrideFields(id,{fields:{research:{evidenceStages:[{value:'clinical',quote:body}]}},version:0,reason:'核对来源'},'test-editor'),/来源依据不足/);
 await overrideFields(id,{fields:{research:{claims:{results:{text:'活性降低25%。',quote:'activity reduced by 25 percent'}}},researchBibliography:{...bib,doi:`10.1234/${T}-corrected`}},version:0,reason:'原文核对文献字段与结果'},'test-editor');
 await publishArticle(id);const [p]=await sql`SELECT research FROM publications WHERE article_id=${id}`;assert.equal(p!.research.bibliography.doi,`10.1234/${T}-corrected`);assert.equal(p!.research.claims.results,'活性降低25%。');
 await assert.rejects(overrideFields(id,{fields:{summary:'并发修改'},version:0,reason:'测试'},'test-editor'),/刷新/);
 const [log]=await sql`SELECT action FROM audit_log WHERE subject=${`content:${id}`} ORDER BY id DESC LIMIT 1`;assert.equal(log!.action,'content.override');
 await rerun(id,'research',`research-${T}`,'test-editor');const [a]=await sql`SELECT research_retry_at,research_enriched_at FROM articles WHERE id=${id}`;assert.equal(a!.research_enriched_at,null);
 await sql`UPDATE articles SET body_text='This updated source describes a different study without the old measured results.',revision=revision+1 WHERE id=${id}`;
 await publishArticle(id);const [updated]=await sql`SELECT research FROM publications WHERE article_id=${id}`;
 assert.equal(updated!.research.claims.results,null);assert.notEqual(updated!.research.status,'ready');
});
test('backfill valves and malformed model output keep reading available and schedule a retry',async()=>{
 const id=await record(6);
 await sql`UPDATE articles SET discovered_at=now()+interval '1 day' WHERE id=${id}`;
 const previous={enabled:process.env.RESEARCH_BACKFILL_ENABLED,model:process.env.MODEL_CALLS_ENABLED,structure:process.env.STRUCTURE_MODEL,url:process.env.LLM_BASE_URL,key:process.env.LLM_API_KEY};
 const provider=await stub(()=>({choices:[{message:{content:JSON.stringify({research:{}})}}],usage:{prompt_tokens:1,completion_tokens:1}}));
 try {
  process.env.RESEARCH_BACKFILL_ENABLED='true';process.env.MODEL_CALLS_ENABLED='false';
  assert.equal((await backfillResearch({limit:1})).disabled,true);assert.equal(provider.hits(),0);
  process.env.MODEL_CALLS_ENABLED='true';process.env.STRUCTURE_MODEL='default';process.env.LLM_BASE_URL=provider.url;process.env.LLM_API_KEY='local-test-only';process.env.LLM_MODEL='test-model';
  const result=await backfillResearch({limit:1});assert.equal(result.failed,1);assert.ok(provider.hits()>0);
  const [a]=await sql`SELECT research_retry_at FROM articles WHERE id=${id}`;assert.ok(a!.research_retry_at>new Date());
  assert.equal((await loadItemDetail(id)).kind,'found');
  await sql`UPDATE articles SET research_backfill_attempted_at=NULL WHERE id=${id}`;
 } finally {
  for(const [key,value] of Object.entries({RESEARCH_BACKFILL_ENABLED:previous.enabled,MODEL_CALLS_ENABLED:previous.model,STRUCTURE_MODEL:previous.structure,LLM_BASE_URL:previous.url,LLM_API_KEY:previous.key})) value===undefined?delete process.env[key]:process.env[key]=value;
  await provider.close();
 }
});
test('concurrent legacy enrichment claims enforce the rolling daily cap',async()=>{
 const ids=[];for(let n=20;n<43;n++) ids.push(await record(n));
 const results=await Promise.all(ids.map(id=>claimResearchBackfill(id)));assert.equal(results.filter(Boolean).length,20);assert.equal(await claimResearchBackfill(ids[0]!),false);
});
