import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const registry=JSON.parse(readFileSync(resolve(root,'industry/journal-metrics.json'),'utf8'));
const sourceHosts=new Set(['www.ebi.ac.uk','europepmc.org','www.nature.com','link.springer.com','europeanpainfederation.eu','www.proteinsociety.org','www.spandidos-publications.com']);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&new Date(x).toISOString().slice(0,10)===x;
const officialUrl=x=>{const u=new URL(x);assert.equal(u.protocol,'https:');assert(sourceHosts.has(u.hostname),`Review new source host: ${u.hostname}`);};
const validIssn=x=>{if(!/^\d{4}-\d{3}[\dX]$/.test(x))return false;const d=x.replace('-','').split('').map(v=>v==='X'?10:Number(v));return d.reduce((sum,v,i)=>sum+v*(8-i),0)%11===0;};
assert.equal(registry.schemaVersion,1);
assert.equal(registry.productionScoringEnabled,false,'Reference registry must not imply production scoring');
assert(date(registry.checkedAt));
const ids=new Set(),issns=new Set();
for(const j of registry.journals){
 assert(!ids.has(j.id),`Duplicate journal ${j.id}`);ids.add(j.id);
 assert(j.name&&j.aliases.length&&date(j.checkedAt));
 assert(j.issns.length&&j.identitySources.length,`Missing journal identity ${j.id}`);
 j.identitySources.forEach(officialUrl);
 for(const issn of j.issns){assert(validIssn(issn),`Invalid ISSN ${issn}`);assert(!issns.has(issn),`Shared ISSN requires identity review ${issn}`);issns.add(issn);}
 assert(['verified-dated','year-unverified','unverified'].includes(j.status));
 assert.equal(j.editorialReferenceScore,null,'Category position is not verified for this reference release');
 assert.equal(j.jcrReleaseYear,null);
 assert.equal(j.categoryVerification,'unverified');assert.deepEqual(j.categories,[]);
 if(j.status==='verified-dated'){
  assert(j.jif&&Number.isFinite(j.jif.value)&&j.jif.value>=0);
  assert(Number.isInteger(j.jif.year)&&j.jif.year>=1900&&j.jif.year<=new Date().getUTCFullYear());
  assert(j.jif.sourceQuote&&j.jif.sourceTitle&&date(j.jif.checkedAt));officialUrl(j.jif.sourceUrl);
  assert(j.jif.sourceQuote.includes(String(j.jif.year)),'Source locator must include the year');
  const quoted=j.jif.sourceQuote.match(/Impact Factor[:\s]+(\d+(?:\.\d+)?)\s*\(\d{4}\)|Impact Factor is (\d+(?:\.\d+)?)/);
  assert(quoted&&Number(quoted[1]??quoted[2])===j.jif.value,'JIF value must match the source locator');
  assert.equal(j.observedUndatedMetric,null);
 }else{
  assert.equal(j.jif,null,'Unverified metric cannot be used as annual JIF');
  if(j.status==='year-unverified'){
   const m=j.observedUndatedMetric;assert(m&&Number.isFinite(m.value)&&m.value>=0);
   assert.equal(m.year,null);assert(date(m.checkedAt));officialUrl(m.sourceUrl);
  }else assert.equal(j.observedUndatedMetric,null);
 }
}
const docs=['docs/journal-metrics.md','docs/annotation-protocol.md','docs/annotation-cards-2026-10-06.md','docs/annotation-cards-additional-2026-10-06.md','docs/selection.md'];
for(const file of docs){
 const text=readFileSync(resolve(root,file),'utf8');
 for(const [,target] of text.matchAll(/\]\(([^)]+)\)/g)){
  if(/^(?:https?:|#)/.test(target))continue;
  assert(existsSync(resolve(root,dirname(file),target.split('#')[0])),`Broken reference ${file}: ${target}`);
 }
}
const cards=docs.filter(f=>f.includes('annotation-cards')).map(f=>readFileSync(resolve(root,f),'utf8')).join('\n');
const cardIds=[...cards.matchAll(/^## (PR-\d{2})[｜|]/gm)].map(m=>m[1]);
assert.equal(cardIds.length,14,'Expected 14 teaching cards');assert.equal(new Set(cardIds).size,14);
const worksheet=readFileSync(resolve(root,'docs/annotation-worksheet.csv'),'utf8');
for(const id of cardIds)assert(worksheet.includes(id),`Worksheet missing ${id}`);
const rows=worksheet.trim().split(/\r?\n/).slice(1);
assert.equal(rows.length,14);
for(const row of rows)assert(/^"PR-\d{2}","[^"]+","(?:[^"]|"")*","[^"]+",(?:"",){9}""$/.test(row),'Public worksheet judgments must remain blank; save completed labels privately');
console.log(JSON.stringify({ok:true,journals:ids.size,verifiedAnnualJif:registry.journals.filter(j=>j.jif).length,teachingCards:cardIds.length,journalMetricsUsedInProductionScoring:false}));
