import "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql,closeDb } from "@aihot/backend/db";
after(closeDb);
test("anonymous Supabase roles cannot read or write backend tables",async()=>{
  for(const role of ["anon","authenticated"]) {
    const [exists]=await sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`;
    if(!exists) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
  }
  await sql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated");
  await sql.unsafe(readFileSync(new URL("../database/migrations/0039_hosted_access.sql",import.meta.url),"utf8"));
  for(const role of ["anon","authenticated"]) {
    for(const query of ["SELECT * FROM feedback", "INSERT INTO settings (key,value) VALUES ('denied','{}')", "UPDATE settings SET value='{}'", "DELETE FROM settings"]) {
      await assert.rejects(sql.begin(async tx=>{
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe(query);
      }),/permission denied/);
    }
  }
  const [row]=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity`;
  assert.equal(row.n,0);
});
