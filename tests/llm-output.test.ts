import './setup.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extractJson} from '@aihot/backend/providers/llm';
test('normally finished JSON can close only its missing outer envelope without changing any value',()=>{
 const complete={research:{claims:{question:{text:'研究问题',quote:'A string containing } and an escaped "quote".'}},stages:[]}};
 const text=JSON.stringify(complete);assert.deepEqual(extractJson(text),complete);assert.deepEqual(extractJson(text.slice(0,-1),true),complete);
 assert.throws(()=>extractJson(text.slice(0,-1),false));
 for(const broken of ['{"research":{"claims":{', '{"research":{"question":"unfinished}', '{"research":{"stages":[1,2}', '{"research":{"question":null,}', '{"research":{"question":}}']) assert.throws(()=>extractJson(broken,true));
});
