// Manual deployment verification: restore privately into the runner's disposable local database.
import {spawn} from "node:child_process";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import postgres from "postgres";
import {createClient} from "@supabase/supabase-js";
import {downloadBackup,decryptBackup} from "./backup-files.ts";

const target=new URL(process.env.VERIFY_DATABASE_URL || "");
if(!["localhost","127.0.0.1"].includes(target.hostname) || target.pathname!=="/pharma_restore") throw new Error("Verification requires the disposable local pharma_restore database");
const client=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
const payload=await downloadBackup(client.storage.from(process.env.SUPABASE_BACKUPS_BUCKET || "pharma-backups"));
const dump=decryptBackup(payload,Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || "","hex"));
const file=path.resolve(".data/backups",`verification-${randomUUID()}.dump`);
await mkdir(path.dirname(file),{recursive:true});
await writeFile(file,dump,{flag:"wx"});
try {
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,["deploy/restore-backup.ts",file],{env:{...process.env,DATABASE_URL:target.toString()},stdio:"inherit"});
  child.on("error",()=>reject(new Error("Unable to start backup verification")));
  child.on("exit",code=>code===0?resolve():reject(new Error("Cloud backup restore verification failed")));
 });
 const db=postgres(target.toString(),{max:1,onnotice:()=>{}});
 try {
  const [sources]=await db<{n:number}[]>`SELECT count(*)::int AS n FROM sources`;
  const [migrations]=await db<{n:number}[]>`SELECT count(*)::int AS n FROM schema_migrations`;
  const [unsecured]=await db<{n:number}[]>`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity`;
  if(sources!.n!==5 || migrations!.n<37 || unsecured!.n!==0) throw new Error("Restored application schema validation failed");
  const counts:Record<string,number>={};
  for(const name of ["articles","analyses","receipts","publications"]) {
   const [row]=await db<{n:number}[]>`SELECT count(*)::int AS n FROM ${db(name)}`;
   counts[name]=row!.n;
  }
  console.log(JSON.stringify({cloudBackupRestored:true,sources:sources!.n,migrations:migrations!.n,rlsAllPublicTables:true,counts}));
 } finally {await db.end();}
} finally {await unlink(file).catch(()=>{});}
