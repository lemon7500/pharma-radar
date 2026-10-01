import './setup.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {baselineResearch,europePmcBibliography,normalizeDoi,materialBasis,validateResearchExtraction,validateAdminResearch} from '@aihot/backend/research/profile';
import {parseResearchFilters} from '@aihot/contracts/research';
import {researchSection} from '@aihot/backend/reports/compose';
import {researchPauseReason} from '@aihot/backend/research/backfill';
const abstract = 'We used machine learning and virtual screening to identify natural products. The compounds were tested in vitro using cultured cells. Activity was reduced by 25 percent. The study does not establish clinical efficacy.';
const material = {title:'Machine learning for natural product drug discovery',bodyText:abstract};
test('legacy enrichment pauses near the free capacity limit or after repeated failures',()=>{
 assert.equal(researchPauseReason(399_999_999,2),false);
 assert.equal(researchPauseReason(400_000_000,0),true);
 assert.equal(researchPauseReason(0,3),true);
});
test('research facets allow cross-topic papers and independent evidence stages',()=>{
 const {profile,support}=validateResearchExtraction({
  foci:[{value:'tcm-natural-products',quote:'identify natural products'},{value:'ai-pharma',quote:'We used machine learning and virtual screening'}],
  areas:[{value:'discovery',quote:'We used machine learning and virtual screening'}],
  evidenceStages:[{value:'computational',quote:'We used machine learning and virtual screening'},{value:'in-vitro',quote:'tested in vitro using cultured cells'}],
  claims:{methods:{text:'采用机器学习、虚拟筛选与体外细胞实验。',quote:'We used machine learning and virtual screening to identify natural products. The compounds were tested in vitro using cultured cells.'},results:{text:'活性降低 25%。',quote:'Activity was reduced by 25 percent.'}},
 },material);
 assert.deepEqual(profile.foci,['tcm-natural-products','ai-pharma']);assert.deepEqual(profile.evidenceStages,['computational','in-vitro']);assert.equal(profile.status,'ready');assert.ok(support['claims.methods']);
 assert.deepEqual(parseResearchFilters(new URLSearchParams('focus=ai-pharma,tcm-natural-products&area=discovery&evidence=computational,invalid&origin=primary')), {area:['discovery'],focus:['ai-pharma','tcm-natural-products'],evidence:['computational'],origin:['primary']});
});
test('titles, references, invented numbers and unsupported clinical labels cannot produce a research note',()=>{
 for (const bodyText of ['', 'References\nA study of results in oncology. DOI 10.1000/a. DOI 10.1000/b. DOI 10.1000/c. '.repeat(3)]) {
  const m={title:'Clinical trial review',bodyText};const r=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:'Clinical trial review'}],claims:{results:{text:'临床疗效提高50%。',quote:'Clinical trial review'}}},m);
  assert.equal(r.profile.status,'insufficient');assert.deepEqual(r.profile.evidenceStages,[]);assert.equal(r.profile.claims.results,null);
 }
 const r=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:'The study does not establish clinical efficacy.'}],clinicalPhase:{value:'III',quote:abstract},claims:{results:{text:'活性降低50%。',quote:'Activity was reduced by 25 percent.'}}},material);
 assert.deepEqual(r.profile.evidenceStages,[]);assert.equal(r.profile.clinicalPhase,null);assert.equal(r.profile.claims.results,null);
 assert.throws(()=>validateAdminResearch({claims:{results:{text:'活性降低50%。',quote:'Activity was reduced by 25 percent.'}}},material),/来源依据不足/);
});
test('clinical phases require an explicit phase in the same source material',()=>{
 const text='In a randomized phase II trial, enrolled patients received the investigational treatment. Methods and results are reported in this clinical trial.';
 const r=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:text}],clinicalPhase:{value:'II',quote:text}}, {title:'Clinical study',bodyText:text});
 assert.deepEqual(r.profile.evidenceStages,['clinical']);assert.equal(r.profile.clinicalPhase,'II');
 const bad=validateResearchExtraction({evidenceStages:[{value:'clinical',quote:text}],clinicalPhase:{value:'III',quote:text}}, {title:'Clinical study',bodyText:text});assert.equal(bad.profile.clinicalPhase,null);
});
test('Europe PMC metadata uses only the paper own identifiers and genuine dates',()=>{
 const b=europePmcBibliography({doi:'https://doi.org/10.1234/OWN',pmid:'1234',authorList:{author:[{fullName:'A Author'},{fullName:'B Author'}]},journalInfo:{journal:{title:'Research Journal'}},firstPublicationDate:'2026-02-30',pubTypeList:{pubType:['Review']},references:[{doi:'10.1234/other'}]});
 assert.equal(b.doi,'10.1234/own');assert.equal(b.publishedDate,null);assert.deepEqual(b.authors,['A Author','B Author']);assert.equal(b.journal,'Research Journal');
 assert.equal(normalizeDoi('10.1234/evil<script>'),null);assert.equal(baselineResearch({title:'Review',bodyText:abstract,bibliography:b}).documentType,'review');
 assert.equal(materialBasis(material),'abstract');assert.equal(materialBasis({...material,fullText:true}),'fulltext');
});
test('brief sections follow research areas and keep policy material separate',()=>{
 assert.equal(researchSection({category:'tcm',researchArea:'mechanisms'}),'药理机制');assert.equal(researchSection({category:'regulation'}),'监管与产业资讯');assert.equal(researchSection({category:'paper'}),'研究环节待确认');
});
