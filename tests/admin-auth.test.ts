// Real opaque sessions, credential rotation and CSRF are exercised against the isolated test DB.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { completeLogin, cookie, endSession, loginRedirect, parseCookies, passwordLogin, safeReturn, SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";
import { adminHandler, createPasswordAttemptLimiter } from "../apps/api/src/routes/admin-auth.ts";

const T = tag();
const password = `fixture-admin-password-${T}`;
const unionId = `fixture-union-${T}`;
const email = `${T}@auth.invalid`;
const previous = {
  password: config.adminPassword, devAdmin: config.devAdmin, siteUrl: config.siteUrl,
  environment: config.environmentName, unionIds: config.adminUnionIds, emails: config.adminEmails,
};
const previousEnv = new Map(["SESSION_SECRET", "FEISHU_LOGIN_APP_ID", "FEISHU_LOGIN_APP_SECRET"].map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
let app: Awaited<ReturnType<typeof buildApp>>;
const users = new Set<number>();
const tokens: string[] = [];

before(async () => {
  config.adminPassword = password;
  config.devAdmin = null;
  config.siteUrl = "https://auth.invalid";
  config.adminUnionIds = [unionId];
  config.adminEmails = [];
  process.env.SESSION_SECRET = `fixture-session-secret-${T}`;
  process.env.FEISHU_LOGIN_APP_ID = `fixture-app-${T}`;
  process.env.FEISHU_LOGIN_APP_SECRET = `fixture-app-secret-${T}`;
  globalThis.fetch = (async (input) => {
    if (String(input) === "https://passport.feishu.cn/suite/passport/oauth/token") return Response.json({ access_token: "fixture-access-token" });
    if (String(input) === "https://passport.feishu.cn/suite/passport/oauth/userinfo") return Response.json({ union_id: unionId, email, name: `Fixture ${T}` });
    throw new Error("Unexpected network request in auth test");
  }) as typeof fetch;
  app = await buildApp();
  app.post("/api/admin/auth-test-write", adminHandler(async () => ({ accepted: true })));
});

after(async () => {
  await app?.close();
  if (tokens.length) await sql`DELETE FROM admin_sessions WHERE id_hash IN ${sql(tokens.map(sha256))}`;
  if (users.size) await sql`DELETE FROM audit_log WHERE actor IN ${sql([...users].map((id) => `admin:${id}`))}`;
  await sql`DELETE FROM admin_users WHERE feishu_union_id = ${unionId}`;
  await closeDb();
  config.adminPassword = previous.password;
  config.devAdmin = previous.devAdmin;
  config.siteUrl = previous.siteUrl;
  config.environmentName = previous.environment;
  config.adminUnionIds = previous.unionIds;
  config.adminEmails = previous.emails;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

const header = (token: string) => `${SESSION_COOKIE}=${token}`;
async function passwordSession(value = config.adminPassword!) {
  const login = await passwordLogin(value, "/admin/runs", "fixture-browser");
  tokens.push(login.token);
  users.add(login.userId);
  return { ...login, principal: (await sessionPrincipal(header(login.token)))! };
}
async function feishuSession() {
  const { stateCookie } = loginRedirect("/admin/runs");
  const login = await completeLogin("fixture-code", stateCookie, stateCookie, "fixture-browser");
  tokens.push(login.token);
  users.add(login.userId);
  return { ...login, principal: (await sessionPrincipal(header(login.token)))! };
}

test("damaged and incomplete cookies do not turn anonymous admin access into an outage", async () => {
  assert.equal(Object.getPrototypeOf(parseCookies("__proto__=value")), null);
  assert.equal(parseCookies("other=%E0%A4%A; normal=ok").normal, "ok");
  for (const value of [undefined, "other=%E0%A4%A", `${SESSION_COOKIE}=%`, `${SESSION_COOKIE}`, `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=`]) {
    const response = await app.inject({ method: "GET", url: "/api/admin/me", headers: value ? { cookie: value } : {} });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const session = await passwordSession();
  const valid = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: `broken=%; ${header(session.token)}` } });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(valid.json().dev, false);
  assert.equal(valid.headers["cache-control"], "no-store");
});

test("password sign-in creates a hashed credential-bound session and secure cookie", async () => {
  const response = await app.inject({ method: "POST", url: "/api/auth/password", payload: { password, return: "/admin/runs" } });
  assert.equal(response.statusCode, 303, response.body);
  assert.equal(response.headers.location, "/admin/runs");
  const setCookie = String(response.headers["set-cookie"]);
  const token = parseCookies(setCookie)[SESSION_COOKIE]!;
  tokens.push(token);
  const principal = await sessionPrincipal(header(token));
  assert.ok(principal && !principal.dev);
  users.add(principal.userId!);
  const [stored] = await sql`SELECT id_hash, auth_method, credential_version FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
  assert.equal(stored!.auth_method, "password");
  assert.notEqual(stored!.id_hash, token);
  assert.match(stored!.credential_version, /^[a-f0-9]{64}$/);
  assert.ok(!stored!.credential_version.includes(password));
  for (const attribute of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]) assert.ok(setCookie.includes(attribute));
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(cookie(SESSION_COOKIE, token, 0, true).includes("Max-Age=0"));
});

test("expired, unknown and legacy sessions cannot enter the admin", async () => {
  const expired = await passwordSession();
  await sql`UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE id_hash = ${sha256(expired.token)}`;
  const legacy = randomBytes(32).toString("base64url");
  tokens.push(legacy);
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at)
    VALUES (${sha256(legacy)}, ${expired.userId}, 'legacy-csrf', now() + interval '1 day')`;
  for (const token of [expired.token, legacy, randomBytes(32).toString("base64url")]) {
    const response = await app.inject({ method: "GET", url: "/api/auth/check", headers: { cookie: header(token) } });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("password and session-secret rotation invalidate previously issued password sessions", async () => {
  const original = await passwordSession();
  config.adminPassword = `${password}-rotated`;
  try {
    assert.equal(await sessionPrincipal(header(original.token)), null);
    const fresh = await passwordSession();
    assert.ok(fresh.principal);
  } finally { config.adminPassword = password; }
  const beforeSecretRotation = await passwordSession();
  const oldSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = `fixture-replacement-secret-${T}`;
  try {
    assert.equal(await sessionPrincipal(header(beforeSecretRotation.token)), null);
    const fresh = await passwordSession();
    assert.ok(fresh.principal);
  } finally { process.env.SESSION_SECRET = oldSecret; }
});

test("Feishu sessions recheck the current allowlist and provider credentials", async () => {
  const session = await feishuSession();
  assert.ok(session.principal && !session.principal.dev);
  config.adminUnionIds = [];
  try {
    assert.equal(await sessionPrincipal(header(session.token)), null);
    config.adminEmails = [email];
    assert.ok(await sessionPrincipal(header(session.token)), "the explicitly allowlisted email remains a valid grant");
  } finally { config.adminUnionIds = [unionId]; config.adminEmails = []; }
  const oldSecret = process.env.FEISHU_LOGIN_APP_SECRET;
  process.env.FEISHU_LOGIN_APP_SECRET = `fixture-rotated-provider-secret-${T}`;
  try { assert.equal(await sessionPrincipal(header(session.token)), null); }
  finally { process.env.FEISHU_LOGIN_APP_SECRET = oldSecret; }
});

test("admin writes require the current session's CSRF token", async () => {
  const a = await passwordSession();
  const b = await passwordSession();
  assert.notEqual(a.principal.csrf, b.principal.csrf);
  for (const csrf of [undefined, "wrong", b.principal.csrf]) {
    const response = await app.inject({ method: "POST", url: "/api/admin/auth-test-write", headers: { cookie: header(a.token), ...(csrf ? { "x-csrf-token": csrf } : {}) } });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const valid = await app.inject({ method: "POST", url: "/api/admin/auth-test-write", headers: { cookie: header(a.token), "x-csrf-token": a.principal.csrf } });
  assert.equal(valid.statusCode, 200, valid.body);
  const anonymous = await app.inject({ method: "POST", url: "/api/admin/auth-test-write", headers: { "x-csrf-token": a.principal.csrf } });
  assert.equal(anonymous.statusCode, 401);
});

test("logout-all is CSRF protected, revokes every device for that user and audits without token values", async () => {
  const a = await passwordSession();
  const b = await passwordSession();
  const other = await feishuSession();
  const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_sessions WHERE user_id = ${a.userId}`;
  const rejected = await app.inject({ method: "POST", url: "/api/admin/sessions/logout-all", headers: { cookie: header(a.token) } });
  assert.equal(rejected.statusCode, 403);
  assert.ok(await sessionPrincipal(header(a.token)));
  const response = await app.inject({ method: "POST", url: "/api/admin/sessions/logout-all", headers: { cookie: header(a.token), "x-csrf-token": a.principal.csrf } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().revoked, before!.n);
  assert.ok(String(response.headers["set-cookie"]).includes("Max-Age=0"));
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(await sessionPrincipal(header(a.token)), null);
  assert.equal(await sessionPrincipal(header(b.token)), null);
  assert.ok(await sessionPrincipal(header(other.token)), "another administrator's device must remain signed in");
  const audits = await sql`SELECT before, after FROM audit_log WHERE actor = ${`admin:${a.userId}`} AND action = 'auth.logout_all'`;
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!.before, { sessions: before!.n });
  assert.deepEqual(audits[0]!.after, { sessions: 0 });
  assert.ok(!JSON.stringify(audits).includes(a.token));
});

test("ordinary logout revokes only the current device", async () => {
  const a = await passwordSession();
  const b = await passwordSession();
  await endSession(header(a.token));
  assert.equal(await sessionPrincipal(header(a.token)), null);
  assert.ok(await sessionPrincipal(header(b.token)));
});

test("production cannot use the development principal and redirects remain local", async () => {
  const environment = config.environmentName;
  config.devAdmin = { displayName: "fixture-dev" };
  config.environmentName = "production";
  try { assert.equal(await sessionPrincipal(undefined), null); }
  finally { config.devAdmin = null; config.environmentName = environment; }
  for (const target of ["//external.invalid/admin", "/adminevil", "javascript:alert(1)", "/"]) assert.equal(safeReturn(target), "/admin");
  assert.equal(safeReturn("https://external.invalid/admin/runs?view=1"), "/admin/runs?view=1");
});

test("per-client rejected attempts cannot exhaust other clients' login allowance or prolong their own lockout", () => {
  const limiter = createPasswordAttemptLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(limiter("attacker", now), null);
  for (let i = 0; i < 5000; i++) assert.equal(limiter("attacker", now + 1000), 899);
  assert.equal(limiter("legitimate", now + 1000), null);
  assert.equal(limiter("attacker", now + 15 * 60_000), null);
});

test("distributed bursts pause briefly and rejected requests cannot extend the global cooldown", () => {
  const limiter = createPasswordAttemptLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 50; i++) assert.equal(limiter(`client-${i}`, now), null);
  assert.equal(limiter("next", now), 30);
  for (let i = 0; i < 1000; i++) assert.equal(limiter(`blocked-${i}`, now + 29_000), 1);
  assert.equal(limiter("legitimate", now + 30_000), null);
});

test("password-route throttling advertises retry time without locking out a fresh client", async () => {
  for (let i = 0; i < 51; i++) await app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: "192.0.2.77", payload: { password: "incorrect-fixture" } });
  const blocked = await app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: "192.0.2.77", payload: { password: "incorrect-fixture" } });
  assert.match(blocked.headers.location!, /error=too-many/);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal(blocked.headers["cache-control"], "no-store");
  const fresh = await app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: "192.0.2.78", payload: { password: "incorrect-fixture" } });
  assert.match(fresh.headers.location!, /error=wrong/);
});
