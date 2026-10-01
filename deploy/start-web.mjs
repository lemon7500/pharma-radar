// Two small processes share a free Render web service. The worker runs in GitHub Actions.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const children = new Set();
let stopping = false;
function start(file, heap = 160) {
  const child = spawn(process.execPath, [`--max-old-space-size=${heap}`, file], {stdio:'inherit', env:{...process.env}});
  children.add(child);
  child.on('error', () => {console.error(`Unable to start ${file}`); void stop(1);});
  child.on('exit', (code) => {children.delete(child); if (!stopping) void stop(code || 1);});
  return child;
}
async function command(file) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[file],{stdio:'inherit'});
    children.add(child);
    child.on('error',reject);
    child.on('exit',(code)=>{children.delete(child);code===0?resolve():reject(new Error(`${file} failed`));});
  });
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const deadline=Date.now()+12000;
  while(children.size && Date.now()<deadline) await delay(100);
  for (const child of children) child.kill('SIGKILL');
  process.exit(code);
}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
try {
  // Database and secrets are never written to build artifacts.
  await command('scripts/migrate.ts');
  await command('scripts/seed.ts');
  await command('deploy/research-baseline.ts');
  process.env.API_PORT ||= '3001';
  process.env.API_HOST = '127.0.0.1';
  process.env.API_BASE_URL = `http://127.0.0.1:${process.env.API_PORT}`;
  process.env.WEB_HOST = '0.0.0.0';
  process.env.WEB_PORT = process.env.PORT || process.env.WEB_PORT || '10000';
  process.env.WORKER_STALE_MINUTES ||= '180';
  start('apps/api/src/main.ts');
  let ready=false;
  for(let i=0;i<60 && !stopping;i++) {
    ready=await fetch(`${process.env.API_BASE_URL}/api/health`,{signal:AbortSignal.timeout(2000)}).then(r=>r.ok,()=>false);
    if(ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('API did not become ready');
  start('apps/web/server.ts',160);
} catch(error) { console.error(error.message); await stop(1); }
