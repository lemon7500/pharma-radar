// Uploaded originals live in private object storage; Render's disk is only a cache.
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config, credential } from "../config.ts";

function filePath(key: string): string {
  if (!/^(uploads|feedback-screenshots)\/[\w.-]+$/.test(key)) throw new Error("invalid durable file key");
  return path.join(config.dataDir, key);
}

function store() {
  const url = process.env.SUPABASE_URL;
  const key = credential("integrations", "SUPABASE_SERVICE_ROLE_KEY");
  const bucket = process.env.SUPABASE_UPLOADS_BUCKET;
  if (!url && !key && !bucket) return null;
  if (!url || !key || !bucket) throw new Error("Incomplete Supabase uploads configuration");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }) },
  }).storage.from(bucket);
}

/** Remember this on a receipt so a later missing configuration cannot pretend a remote deletion succeeded. */
export function durableStorageConfigured(): boolean { return store() !== null; }

export async function putDurableFile(key: string, data: Buffer, contentType: string): Promise<void> {
  const file = filePath(key);
  const remote = store();
  if (remote) {
    const { error } = await remote.upload(key, data, { contentType, upsert: true });
    if (error) throw new Error(`durable upload failed (${error.name})`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

export async function restoreDurableFile(key: string): Promise<boolean> {
  const file = filePath(key);
  if (await stat(file).then((s) => s.isFile(), () => false)) return true;
  const remote = store();
  if (!remote) return false;
  const { data, error } = await remote.download(key);
  if (error) {
    if ("statusCode" in error && String(error.statusCode) === "404") return false;
    throw new Error(`durable download failed (${error.name})`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await data.arrayBuffer()));
  return true;
}

export async function removeDurableFile(key: string, options: { requireRemote?: boolean } = {}): Promise<void> {
  const file = filePath(key);
  const remote = store();
  if (options.requireRemote && !remote) throw new Error("Remote storage configuration is required for this deletion");
  if (remote) {
    const { error } = await remote.remove([key]);
    if (error) throw new Error(`durable deletion failed (${error.name})`);
  }
  await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
