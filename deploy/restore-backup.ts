// Restore only into a fresh application database; never remove or overwrite existing tables.
import { spawn } from "node:child_process";
import { mkdir,writeFile,unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
const [file]=process.argv.slice(2);
if(!file || !process.env.DATABASE_URL) throw new Error("Supply a dump file and DATABASE_URL for a fresh database");
const database=new URL(process.env.DATABASE_URL);
const dir=path.resolve(".data/backups");await mkdir(dir,{recursive:true});
const env={...process.env,PGHOST:database.hostname,PGPORT:database.port || "5432",PGUSER:decodeURIComponent(database.username),PGPASSWORD:decodeURIComponent(database.password),PGDATABASE:database.pathname.slice(1),PGSSLMODE:database.searchParams.get("sslmode") || "require"};
async function restore(args:string[]) {
  return new Promise<string>((resolve,reject)=>{
    const child=spawn("pg_restore",args,{env,stdio:["ignore","pipe","pipe"]});
    let out="",error="";
    child.stdout!.on("data",data=>{out+=String(data);});
    child.stderr!.on("data",data=>{error+=String(data);});
    child.on("error",()=>reject(new Error("pg_restore unavailable")));
    child.on("exit",async code=>{
      if(code===0) return resolve(out);
      await writeFile(path.join(dir,"restore-error.log"),error);
      reject(new Error("Restore failed; diagnostics saved privately in .data/backups/restore-error.log"));
    });
  });
}
const list=await restore(["--list",file]);
if(!list.includes("TABLE public sources") || !list.includes("TABLE public receipts")) throw new Error("Not an application database archive");
const db=postgres(database.toString(),{max:1,onnotice:()=>{}});
let schemas:string[];
try {
  const [tables]=await db<{n:number}[]>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('public','pgboss')`;
  if(tables!.n>0) throw new Error("Restore refused: target application schemas contain tables");
  schemas=(await db<{nspname:string}[]>`SELECT nspname FROM pg_namespace WHERE nspname IN ('public','pgboss')`).map(r=>r.nspname);
  await db.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
} finally {await db.end();}
// Public already exists in a new PostgreSQL/Supabase database. Skip just that schema creation.
const entries=list.split("\n").filter(line=>!schemas.some(schema=>line.includes(` SCHEMA - ${schema} `))).join("\n");
const toc=path.join(dir,`restore-${randomUUID()}.list`);
await writeFile(toc,entries);
try {
  await restore(["--no-owner","--no-acl","--exit-on-error","--use-list",toc,"--dbname",database.pathname.slice(1),file]);
  console.log("Application backup restored into the previously empty database.");
} finally {await unlink(toc).catch(()=>{});}
