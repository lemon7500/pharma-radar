// A manifest is published only after all encrypted parts exist. Free Storage caps files at 50 MB.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { createClient } from "@supabase/supabase-js";
export type BackupStore = Pick<ReturnType<ReturnType<typeof createClient>["storage"]["from"]>, "download" | "upload" | "remove">;
const PART_BYTES = 40 * 1024 * 1024;
const MAX_BYTES = 250 * 1024 * 1024 + 33;
type Manifest = {version:1;format:"PRBK1";at:string;bytes:number;sha256:string;parts:string[]};
const hash = (data:Buffer) => createHash("sha256").update(data).digest("hex");
function parseManifest(text:string):Manifest {
  const m=JSON.parse(text) as Manifest;
  if(m.version!==1 || m.format!=="PRBK1" || !Number.isInteger(m.bytes) || m.bytes<33 || m.bytes>MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(m.sha256) || !Array.isArray(m.parts) || m.parts.length<1 || m.parts.length>7
    || new Set(m.parts).size!==m.parts.length
    || !m.parts.every((key,i)=>typeof key==="string" && /^daily\/[a-f0-9-]{36}\/part-\d{3}\.enc$/.test(key)
      && key.endsWith(`part-${String(i).padStart(3,"0")}.enc`) && key.split("/")[1]===m.parts[0]!.split("/")[1])) {
    throw new Error("Invalid backup manifest");
  }
  return m;
}
export function encryptBackup(dump:Buffer,key:Buffer):Buffer {
  if(key.length!==32) throw new Error("Backup key must contain 32 bytes");
  const iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  const ciphertext=Buffer.concat([cipher.update(dump),cipher.final()]);
  return Buffer.concat([Buffer.from("PRBK1"),iv,cipher.getAuthTag(),ciphertext]);
}
export function decryptBackup(payload:Buffer,key:Buffer):Buffer {
  if(key.length!==32 || payload.length<33 || payload.subarray(0,5).toString()!=="PRBK1") throw new Error("Invalid backup or key");
  const decipher=createDecipheriv("aes-256-gcm",key,payload.subarray(5,17));
  decipher.setAuthTag(payload.subarray(17,33));
  return Buffer.concat([decipher.update(payload.subarray(33)),decipher.final()]);
}
export async function uploadBackup(store:BackupStore,payload:Buffer):Promise<void> {
  if(payload.length<33 || payload.length>MAX_BYTES) throw new Error("Backup exceeds the free storage allocation");
  const previous=await store.download("daily/latest.json");
  if(previous.error && !("statusCode" in previous.error && String(previous.error.statusCode)==="404")) throw new Error("Cannot read backup manifest");
  const old=previous.data ? parseManifest(await previous.data.text()) : null;
  const prefix=`daily/${randomUUID()}`;
  const parts:string[]=[];
  let published=false;
  let manifestAttempted=false;
  try {
    for(let offset=0;offset<payload.length;offset+=PART_BYTES) {
      const name=`${prefix}/part-${String(parts.length).padStart(3,"0")}.enc`;
      // Track even a response lost after upload, so a failed run can clean its own objects.
      parts.push(name);
      const {error}=await store.upload(name,payload.subarray(offset,offset+PART_BYTES),{contentType:"application/octet-stream",upsert:false});
      if(error) throw new Error("Backup part upload failed");
    }
    const manifest:Manifest={version:1,format:"PRBK1",at:new Date().toISOString(),bytes:payload.length,sha256:hash(payload),parts};
    manifestAttempted=true;
    const {error}=await store.upload("daily/latest.json",JSON.stringify(manifest),{contentType:"application/json",upsert:true});
    if(error) throw new Error("Backup manifest upload failed");
    published=true;
    if(old) {
      const {error}=await store.remove(old.parts);
      if(error) console.warn("Previous backup parts need manual cleanup; latest backup is complete.");
    }
  } finally {
    // A lost response may mean the manifest already points here. Keep both copies in that case.
    if(!published && !manifestAttempted && parts.length) await store.remove(parts).catch(()=>{});
  }
}
export async function downloadBackup(store:BackupStore):Promise<Buffer> {
  const {data,error}=await store.download("daily/latest.json");
  if(error || !data) throw new Error("Backup manifest download failed");
  const manifest=parseManifest(await data.text());
  const chunks:Buffer[]=[];
  let bytes=0;
  for(const name of manifest.parts) {
    const {data,error}=await store.download(name);
    if(error || !data || data.size>PART_BYTES) throw new Error("Backup part download failed");
    const chunk=Buffer.from(await data.arrayBuffer());
    bytes+=chunk.length;
    if(bytes>MAX_BYTES) throw new Error("Backup size exceeds limit");
    chunks.push(chunk);
  }
  const payload=Buffer.concat(chunks);
  if(bytes!==manifest.bytes || hash(payload)!==manifest.sha256) throw new Error("Backup integrity check failed");
  return payload;
}
