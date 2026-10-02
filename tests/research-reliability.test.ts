import './setup.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scientificText,researchMaterialFingerprint} from '@aihot/backend/research/material';
import {normalizeBibliography,validateResearchExtraction,baselineResearch,outsidePharmacy} from '@aihot/backend/research/profile';
import {fetchEuropePmc} from '@aihot/backend/sources/europe-pmc';
import type {SourceRow} from '@aihot/backend/sources/types';
const bibliography=normalizeBibliography({doi:'10.1234/own',journal:'Test Journal',publicationTypes:['Journal Article']});
const body='We investigated a natural plant extract for drug discovery. We treated mice in vivo and cultured RAW264.7 cells in vitro. Results showed reduced inflammation (P < 0.001) and Ca²⁺ efflux (P > 0.05). The small sample limits generalization.';
const material={title:'Natural plant extract for drug discovery',bodyText:body,bibliography};
const claims={object:{text:'研究植物提取物。',quote:'We investigated a natural plant extract for drug discovery.'},methods:{text:'开展小鼠和体外细胞实验。',quote:'We treated mice in vivo and cultured RAW264.7 cells in vitro.'},results:{text:'炎症下降（P < 0.001）。',quote:'Results showed reduced inflammation (P < 0.001) and Ca²⁺ efflux (P > 0.05).'}};
test('scientific HTML retains literal comparisons, entities, sub/superscripts and following paragraphs; normalisation is idempotent',()=>{
 const html='<h4>Results</h4><p>P < 0.001; P &gt; 0.05; IL-1β; Ca<sup>2+</sup> efflux and CO<sub>2</sub>.</p><h4>Limitations</h4><p>A small sample limits generalization.</p><h4>Conclusion</h4><p>Further studies are required.</p>';
 const text=scientificText(html);
 for(const part of ['P < 0.001','P > 0.05','Ca²⁺','CO₂','small sample','Conclusion','Further studies']) assert.ok(text.includes(part),part);
 assert.equal(scientificText(text),text);
 assert.equal(scientificText('P &lt; 0.001 and &lt;i&gt;in vitro&lt;/i&gt;.'),'P < 0.001 and in vitro.');
 assert.equal(scientificText('<sup>abc</sup> <sub>x</sub>'), '^{abc} _{x}');
});
test('long quotes are rejected intact and diagnosed; short complete result quotes retain supported decimals',()=>{
 const long='We tested a drug. '.repeat(35)+'Pearson r = 0.98.';
 const rejected=validateResearchExtraction({claims:{results:{text:'相关系数为0.98。',quote:long}}},{title:'Drug test',bodyText:long,bibliography});
 assert.equal(rejected.profile.claims.results,null);assert.equal(rejected.support['claims.results'],undefined);assert.equal(rejected.rejections['claims.results'],'quote-too-long');
 const ok=validateResearchExtraction({claims:{results:{text:'相关系数为0.98。',quote:'Pearson r = 0.98.'}}},{title:'Drug test',bodyText:long,bibliography});assert.equal(ok.profile.claims.results,'相关系数为0.98。');
});
test('identical digits cannot justify a changed statistical comparison or turn bibliometrics into efficacy',()=>{
 const result=validateResearchExtraction({claims:{results:{text:'炎症下降（P > 0.001）。',quote:'Results showed reduced inflammation (P < 0.001)'}}},material);
 assert.equal(result.profile.claims.results,null);assert.equal(result.rejections['claims.results'],'comparison-not-in-quote');
 const text='We performed a bibliometric analysis of drug publications in kidney disease. Publication trends and citation hotspots concerned mitophagy and inflammatory mechanisms.';
 const indexed=validateResearchExtraction({claims:{results:{text:'证实了线粒体自噬相关药物的药效。',quote:'Publication trends and citation hotspots concerned mitophagy and inflammatory mechanisms.'}}},{title:'Drug bibliometrics',bodyText:text,bibliography});assert.equal(indexed.profile.claims.results,null);assert.equal(indexed.rejections['claims.results'],'bibliometric-is-not-efficacy');
});
test('original and method research require object, methods and results; review readiness requires object and takeaways',()=>{
 assert.equal(validateResearchExtraction({claims:{object:claims.object}},material).profile.status,'pending');
 assert.equal(validateResearchExtraction({claims:{object:claims.object,methods:claims.methods}},material).profile.status,'pending');
 assert.equal(validateResearchExtraction({claims},material).profile.status,'ready');
 const review={...material,bibliography:{...bibliography,publicationTypes:['Review']}};
 assert.equal(validateResearchExtraction({claims:{object:claims.object,results:claims.results}},review).profile.status,'ready');
 assert.equal(validateResearchExtraction({claims:{methods:claims.methods}},review).profile.status,'pending');
});
test('an absence in acquired material is a site scope statement, not a sourced study limitation',()=>{
 const result=validateResearchExtraction({claims:{limitations:{text:'摘要未报告研究局限。',quote:'Results showed reduced inflammation (P < 0.001) and Ca²⁺ efflux (P > 0.05).'}}},material);
 assert.equal(result.profile.claims.limitations,null);assert.equal(result.rejections['claims.limitations'],'material-scope-is-not-study-limitation');
 const valid=validateResearchExtraction({claims:{limitations:{text:'样本较小，推广范围有限。',quote:'The small sample limits generalization.'}}},material);assert.ok(valid.profile.claims.limitations);
});
test('AI outlook, ordinary docking, and agricultural-only natural products do not acquire the focus',()=>{
 const outlook='This review examines triazole drug candidates and molecular docking. Future artificial intelligence may improve optimization of candidate compounds.';
 const result=validateResearchExtraction({foci:[{value:'ai-pharma',quote:'Future artificial intelligence may improve optimization of candidate compounds.'}]},{title:'Triazole drug review',bodyText:outlook,bibliography});assert.deepEqual(result.profile.foci,[]);assert.equal(result.rejections['foci.ai-pharma'],'outside-topic-boundary');
 const agro='We isolated natural products from plants for agrochemical herbicides and tested plant toxicity against weeds. The crop analysis informs agricultural applications.';
 assert.equal(outsidePharmacy(agro),true);
 assert.deepEqual(validateResearchExtraction({foci:[{value:'tcm-natural-products',quote:'We isolated natural products from plants for agrochemical herbicides'}]},{title:'Plant herbicide',bodyText:agro,bibliography}).profile.foci,[]);
 const heterocycle='We review heterocyclic quinoline derivatives for anticancer drug discovery and describe synthesis and structure activity relationships without natural product origins.';
 assert.deepEqual(validateResearchExtraction({foci:[{value:'tcm-natural-products',quote:'heterocyclic quinoline derivatives for anticancer drug discovery'}]},{title:'Quinoline review',bodyText:heterocycle,bibliography}).profile.foci,[]);
 const ai='We developed a deep learning model for drug screening and evaluated prediction accuracy. Natural plant extracts were tested for pharmacological effects in cultured cells.';
 const cross=validateResearchExtraction({foci:[{value:'ai-pharma',quote:'We developed a deep learning model for drug screening'},{value:'tcm-natural-products',quote:'Natural plant extracts were tested for pharmacological effects'}],evidenceStages:[{value:'computational',quote:'We developed a deep learning model for drug screening'}]},{title:'Drug screening tool',bodyText:ai,bibliography});assert.equal(cross.profile.foci.length,2);assert.deepEqual(cross.profile.evidenceStages,['computational']);
});
test('cells from mice and patient datasets do not imply animal experiments or clinical trials',()=>{
 const text='We used mouse-derived cells in vitro and analyzed patient data using a deep learning model. No clinical trial was performed and future clinical studies are needed.';
 const result=validateResearchExtraction({evidenceStages:[{value:'animal',quote:'We used mouse-derived cells in vitro'},{value:'in-vitro',quote:'We used mouse-derived cells in vitro'},{value:'clinical',quote:'No clinical trial was performed and future clinical studies are needed.'},{value:'computational',quote:'analyzed patient data using a deep learning model'}]},{title:'Drug prediction',bodyText:text,bibliography});assert.deepEqual(result.profile.evidenceStages,['in-vitro','computational']);
 const actual=validateResearchExtraction({evidenceStages:[{value:'animal',quote:'We treated mice in vivo and cultured RAW264.7 cells in vitro.'}]},material);assert.deepEqual(actual.profile.evidenceStages,['animal']);
});
test('review clinical evidence and publisher news preserve their own roles and cannot claim a clinical phase',()=>{
 const text='This review covers randomized phase II clinical trials and their limitations. It discusses drug development and evidence from multiple published studies.';
 const review=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:'This review covers randomized phase II clinical trials'}],clinicalPhase:{value:'II',quote:'This review covers randomized phase II clinical trials'}},{title:'Clinical review',bodyText:text,bibliography:{...bibliography,publicationTypes:['Review']}});
 assert.deepEqual(review.profile.evidenceStages,['clinical']);assert.equal(review.profile.clinicalPhase,null);
 const news=baselineResearch({...material,bibliography:{...bibliography,publicationTypes:['News']}});assert.equal(news.origin,'secondary');assert.equal(news.materialKind,'publisher-summary');assert.equal(news.bibliography.doi,'10.1234/own');assert.equal(news.documentType,'news-policy');
 const clinical=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:'randomized phase II clinical trials'}],clinicalPhase:{value:'II',quote:'randomized phase II clinical trials'}},{title:'Clinical trial',bodyText:text,bibliography});assert.equal(clinical.profile.clinicalPhase,'II');
});
test('material fingerprints change with corrected abstracts or own metadata, without dependence on collection time',()=>{
 assert.equal(researchMaterialFingerprint(material),researchMaterialFingerprint({...material}));assert.notEqual(researchMaterialFingerprint(material),researchMaterialFingerprint({...material,bodyText:body+' Corrected result.'}));assert.notEqual(researchMaterialFingerprint(material),researchMaterialFingerprint({...material,bibliography:{...bibliography,doi:'10.1234/new'}}));
});
const source:SourceRow={id:'pmc-test',name:'PMC',kind:'json_list',tier:'T1_5',participation_mode:'editorial',first_party:false,interval_minutes:180,enabled:true,cursor:null,fail_count:0,config:{url:'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=drug%20AND%20FIRST_PDATE%3A%5BNOW-7DAYS%20TO%20NOW%5D&sort_date=y',itemsPath:'resultList.result',titlePaths:['title'],urlTemplate:'https://europepmc.org/article/MED/{id}',summaryPaths:['abstractText'],summaryIsBody:true,publishedAtPath:'firstPublicationDate'}};
const page=(start:number,count=15,next:string|null='next',hitCount=100)=>({hitCount,nextCursorMark:next,resultList:{result:Array.from({length:count},(_,n)=>({id:String(start+n),title:`Drug ${start+n}`,abstractText:body,doi:`10.1234/${start+n}`,firstPublicationDate:'2026-10-02'}))}});
test('Europe PMC caps at three pages, moves sorting into the query and continues a fixed date window',async()=>{
 const original=structuredClone(source),requests:URL[]=[];
 const first=await fetchEuropePmc(original,{now:Date.parse('2026-10-02T12:00:00Z'),read:async url=>{const u=new URL(url);requests.push(u);return page(requests.length*15,15,'cursor'+requests.length);}});
 assert.equal(requests.length,3);assert.equal(first.candidates.length,45);assert.equal(original.cursor,null);assert.equal(first.cursor.windows[0]!.cursor,'cursor3');
 assert.ok(requests.every(u=>u.searchParams.get('query')!.includes('sort_date:y')&&!u.searchParams.has('sort_date')&&u.searchParams.get('pageSize')==='15'));
 const secondRequests:URL[]=[];
 const saved={...source,cursor:{initializedAt:'date',europePmc:first.cursor}};
 const second=await fetchEuropePmc(saved,{now:Date.parse('2026-10-03T12:00:00Z'),read:async url=>{const u=new URL(url);secondRequests.push(u);return page(secondRequests.length*15,15,'continued'+secondRequests.length);}});
 assert.equal(secondRequests[0]!.searchParams.get('cursorMark'),'*');assert.equal(secondRequests[1]!.searchParams.get('cursorMark'),'cursor3');assert.match(secondRequests[1]!.searchParams.get('query')!,/2026-09-25 TO 2026-10-02/);assert.equal(second.cursor.windows.length,2);assert.equal(saved.cursor.europePmc.windows[0]!.cursor,'cursor3');
});
test('pagination duplicates, empty tail, failures and source-query changes keep a safe resume position',async()=>{
 let count=0;
 const duplicate=await fetchEuropePmc(source,{now:Date.parse('2026-10-02'),read:async()=>{count++;return count<3?page(1,15,'cursor'+count):page(1,0,null);}});
 assert.equal(duplicate.candidates.length,15);assert.equal(duplicate.cursor.windows.length,0);assert.equal(duplicate.detail.duplicates,15);
 const pending=await fetchEuropePmc(source,{now:Date.parse('2026-10-02'),read:async()=>page(1,15,'cursor'+(++count))});
 const saved={...source,cursor:{europePmc:pending.cursor}},before=JSON.stringify(saved.cursor);count=0;
 await assert.rejects(fetchEuropePmc(saved,{now:Date.parse('2026-10-03'),read:async()=>{if(++count===2)throw new Error('temporary failure');return page(1,15,'latest');}}),/temporary failure/);assert.equal(JSON.stringify(saved.cursor),before);
 const changed={...saved,config:{...source.config,url:source.config.url.replace('query=drug','query=cancer')}};
 const urls:string[]=[];await fetchEuropePmc(changed,{now:Date.parse('2026-10-03'),read:async url=>{urls.push(url);return page(1,0,null,0);}});assert.equal(new URL(urls[0]!).searchParams.get('cursorMark'),'*');assert.ok(urls.every(u=>new URL(u).searchParams.get('query')!.startsWith('cancer')));
});
