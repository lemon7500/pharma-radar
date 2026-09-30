// One encrypted daily dump, kept privately in Supabase Storage. No artifacts in the public repo.
import { spawn } from "node:child_process";
import { readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { encryptBackup, uploadBackup } from "./backup-files.ts";
const database = new URL(process.env.DATABASE_URL!);
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || "", "hex");
if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must contain 32 bytes");
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing backup storage credentials");
const bucket = process.env.SUPABASE_BACKUPS_BUCKET || "pharma-backups";
const dir = path.resolve(".data/backups");
await mkdir(dir, { recursive: true });
const file = path.join(dir, "latest.dump");
try {
  const env = { ...process.env, PGHOST:database.hostname, PGPORT:database.port || "5432", PGUSER:decodeURIComponent(database.username), PGPASSWORD:decodeURIComponent(database.password), PGDATABASE:database.pathname.slice(1), PGSSLMODE:database.searchParams.get("sslmode") || "require" };
  await new Promise<void>((resolve,reject)=>{
    const child=spawn("pg_dump",["--format=custom","--no-owner","--no-acl","--schema=public","--schema=pgboss","--file",file],{env,stdio:["ignore","ignore","pipe"]});
    child.stderr!.resume();
    child.on("error",()=>reject(new Error("pg_dump unavailable")));
    child.on("exit",code=>code===0?resolve():reject(new Error("pg_dump failed")));
  });
  // Check that PostgreSQL can read the archive before replacing the daily copy.
  await new Promise<void>((resolve,reject)=>{
    const child=spawn("pg_restore",["--list",file],{stdio:["ignore","ignore","ignore"]});
    child.on("error",()=>reject(new Error("pg_restore unavailable")));
    child.on("exit",code=>code===0?resolve():reject(new Error("Backup archive validation failed")));
  });
  const dump = await readFile(file);
  if (dump.length > 250 * 1024 * 1024) throw new Error("Backup exceeds the free storage allocation");
  const payload = encryptBackup(dump,key);
  const client=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  await uploadBackup(client.storage.from(bucket),payload);
  console.log(`Encrypted database backup saved (${payload.length} bytes).`);
} finally {await unlink(file).catch(()=>{});}
