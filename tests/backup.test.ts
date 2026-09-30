import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptBackup,decryptBackup,uploadBackup,downloadBackup,type BackupStore } from "../deploy/backup-files.ts";
function memoryStore() {
  const files=new Map<string,Buffer>();
  let failPart=false;
  const store={
    async download(key:string) {return files.has(key) ? {data:new Blob([new Uint8Array(files.get(key)!)]),error:null} : {data:null,error:{statusCode:"404"}};},
    async upload(key:string,data:Buffer|string) {
      if(failPart && key.endsWith("part-001.enc")) return {error:new Error("network interruption")};
      const body=Buffer.from(data);
      assert.ok(body.length<50_000_000,"each object fits the free 50 MB file limit");
      files.set(key,body);
      return {error:null};
    },
    async remove(keys:string[]) {for(const key of keys) files.delete(key);return {error:null};},
  } as unknown as BackupStore;
  return {files,store,fail:()=>{failPart=true;}};
}
test("encrypted multipart backup survives cache loss and replaces only a complete previous copy",async()=>{
  const {files,store}=memoryStore();
  const key=randomBytes(32);
  const old=encryptBackup(Buffer.from("previous database"),key);
  await uploadBackup(store,old);
  const oldParts=JSON.parse(files.get("daily/latest.json")!.toString()).parts as string[];
  const dump=Buffer.alloc(41*1024*1024,0x61);
  const payload=encryptBackup(dump,key);
  await uploadBackup(store,payload);
  const restored=await downloadBackup(store);
  assert.deepEqual(decryptBackup(restored,key),dump);
  assert.ok(oldParts.every(part=>!files.has(part)));
  assert.equal(files.size,3,"two encrypted parts and the manifest");
  const part=JSON.parse(files.get("daily/latest.json")!.toString()).parts[0];
  files.get(part)![40]^=1;
  await assert.rejects(downloadBackup(store),/integrity/);
});
test("an interrupted part upload preserves the previous daily backup and removes partial objects",async()=>{
  const memory=memoryStore();
  const old=encryptBackup(Buffer.from("usable previous copy"),randomBytes(32));
  await uploadBackup(memory.store,old);
  const before=new Set(memory.files.keys());
  memory.fail();
  await assert.rejects(uploadBackup(memory.store,Buffer.alloc(41*1024*1024)),/part upload/);
  assert.deepEqual(new Set(memory.files.keys()),before);
  assert.deepEqual(await downloadBackup(memory.store),old);
});
test("backup authentication rejects a wrong key and tampered encrypted content",()=>{
  const key=randomBytes(32),data=encryptBackup(Buffer.from("private database"),key);
  assert.throws(()=>decryptBackup(data,randomBytes(32)));
  data[data.length-1]!^=1;
  assert.throws(()=>decryptBackup(data,key));
});
test("a lost manifest response cannot delete the newly published encrypted parts",async()=>{
  const memory=memoryStore();
  await uploadBackup(memory.store,encryptBackup(Buffer.from("previous"),randomBytes(32)));
  const upload=memory.store.upload.bind(memory.store);
  memory.store.upload=(async (...args:Parameters<BackupStore["upload"]>)=>{
    const result=await upload(...args);
    return args[0]==="daily/latest.json" ? {data:null,error:new Error("response lost")} : result;
  }) as BackupStore["upload"];
  const payload=encryptBackup(Buffer.from("complete current"),randomBytes(32));
  await assert.rejects(uploadBackup(memory.store,payload),/manifest upload/);
  assert.deepEqual(await downloadBackup(memory.store),payload);
});
