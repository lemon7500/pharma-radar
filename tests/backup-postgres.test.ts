// Linux CI supplies PostgreSQL 17 clients. All Storage calls go to a local HTTP server.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFile,unlink } from "node:fs/promises";
import path from "node:path";
import { test,after } from "node:test";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { sql,closeDb } from "@aihot/backend/db";
import { getBoss,stopBoss } from "@aihot/backend/jobs/queue";
import { downloadBackup,decryptBackup } from "../deploy/backup-files.ts";
after(closeDb);
function run(command:string,args:string[],env:NodeJS.ProcessEnv) {
  return new Promise<void>((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:["ignore","ignore","pipe"]});
    let message="";
    child.stderr!.on("data",data=>{message+=String(data);});
    child.on("error",reject);
    child.on("exit",code=>code===0?resolve():reject(new Error(`${command} failed: ${message.slice(-1000)}`)));
  });
}
test("a real PostgreSQL archive uploads privately, decrypts and restores its application tables",{skip:process.env.TEST_PG_BACKUP!=="true" && "PostgreSQL 17 client integration runs in Linux CI"},async()=>{
  const files=new Map<string,Buffer>();
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.apikey,"local-backup-test-key");
    const key=decodeURIComponent((req.url || "").split("pharma-backups/")[1] || "");
    if(req.method==="GET") {
      const file=files.get(key);
      res.writeHead(file?200:404,{"content-type":file?"application/octet-stream":"application/json"});
      res.end(file || JSON.stringify({message:"not found",error:"not found",statusCode:"404"}));
      return;
    }
    const chunks:Buffer[]=[];
    for await(const chunk of req) chunks.push(Buffer.from(chunk));
    if(req.method==="POST") files.set(key,Buffer.concat(chunks));
    if(req.method==="DELETE") for(const name of JSON.parse(Buffer.concat(chunks).toString()).prefixes) files.delete(name);
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({Key:key}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const storageUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const key=randomBytes(32);
  const database=new URL(process.env.DATABASE_URL!);
  database.searchParams.set("sslmode","disable");
  const restoredUrl=new URL(database);restoredUrl.pathname="/backup_restore_ci";
  let restored:ReturnType<typeof postgres>|undefined;
  let created=false;
  const dump=path.resolve(".data/backups/integration-restore.dump");
  try {
    await getBoss();await stopBoss();
    await sql.unsafe("CREATE DATABASE backup_restore_ci");created=true;
    restored=postgres(restoredUrl.toString(),{max:1});
    const env={...process.env,DATABASE_URL:database.toString(),SUPABASE_URL:storageUrl,SUPABASE_SERVICE_ROLE_KEY:"local-backup-test-key",SUPABASE_BACKUPS_BUCKET:"pharma-backups",BACKUP_ENCRYPTION_KEY:key.toString("hex")};
    await run(process.execPath,["deploy/backup.ts"],env);
    const store=createClient(storageUrl,"local-backup-test-key",{auth:{persistSession:false,autoRefreshToken:false}}).storage.from("pharma-backups");
    await writeFile(dump,decryptBackup(await downloadBackup(store),key));
    await run(process.execPath,["deploy/restore-backup.ts",dump],{...process.env,DATABASE_URL:restoredUrl.toString()});
    for(const table of ["sources","receipts","analyses"]) {
      const [original]=await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      const copiedRows:Array<{n:number}>=await restored.unsafe<{n:number}[]>(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(copiedRows[0]!.n,original!.n,`${table} restored without losing rows`);
    }
  } finally {
    await restored?.end();
    if(created) await sql.unsafe("DROP DATABASE backup_restore_ci");
    await unlink(dump).catch(()=>{});
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
