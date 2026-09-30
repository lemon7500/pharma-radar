import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { putDurableFile, removeDurableFile, restoreDurableFile } from "@aihot/backend/operations/durable-files";

const objects = new Map<string, Buffer>();
let failing = false;
const server = http.createServer(async (req,res)=>{
  assert.equal(req.headers.apikey,"test-storage-secret");
  assert.equal(req.headers.authorization,"Bearer test-storage-secret");
  if (failing) {res.writeHead(500,{"Content-Type":"application/json"});return res.end('{"message":"temporarily unavailable"}');}
  const key=decodeURIComponent(req.url!.split("/object/")[1] || "");
  if(req.method==="DELETE" && req.url?.endsWith("/object/test-uploads")) {
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    for(const prefix of input.prefixes) objects.delete(`test-uploads/${prefix}`);
    return res.end('[]');
  }
  if(req.method==="POST") {
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    objects.set(key,Buffer.concat(chunks));res.setHeader('Content-Type','application/json');return res.end('{"Key":"ok"}');
  }
  const data=objects.get(key);
  if(!data) {res.writeHead(404,{"Content-Type":"application/json"});return res.end('{"statusCode":"404","error":"not_found","message":"not found"}');}
  res.writeHead(200,{"Content-Type":"image/png"});res.end(data);
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=(server.address() as {port:number}).port;
process.env.SUPABASE_URL=`http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY="test-storage-secret";
process.env.SUPABASE_UPLOADS_BUCKET="test-uploads";
after(async()=>{
  delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_ROLE_KEY;delete process.env.SUPABASE_UPLOADS_BUCKET;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
});

test("private originals survive loss of a container cache and are deleted from both stores",async()=>{
  const key="feedback-screenshots/durable-test.png";
  const file=path.join(config.dataDir,key);
  await putDurableFile(key,Buffer.from("private screenshot"),"image/png");
  assert.equal(objects.get(`test-uploads/${key}`)?.toString(),"private screenshot");
  await unlink(file);
  assert.equal(await restoreDurableFile(key),true);
  assert.equal((await readFile(file)).toString(),"private screenshot");
  await removeDurableFile(key);
  assert.equal(objects.has(`test-uploads/${key}`),false);
  assert.equal(await restoreDurableFile(key),false);
});
test("a failed durable write is reported and unsafe paths cannot leave the data directory",async()=>{
  failing=true;
  await assert.rejects(putDurableFile("uploads/failed.png",Buffer.from("x"),"image/png"),/durable upload failed/);
  failing=false;
  await assert.rejects(putDurableFile("uploads/../../secret",Buffer.from("x"),"image/png"),/invalid durable file key/);
});
