// Admin identity: the admin password (ADMIN_PASSWORD), or optionally Feishu OAuth with an allowlist of
// union_ids / emails; opaque sessions stored hashed, and an audit trail for every manual change.
// Development may impersonate an admin with DEV_AUTH_ROLE=admin; production refuses to start with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export const SESSION_COOKIE = "aihot_admin";
export const STATE_COOKIE = "aihot_oauth_state";
export const SESSION_DAYS = 30;
/** Register this callback in the Feishu open platform when Feishu sign-in is used. */
export const CALLBACK_URL = `${config.siteUrl}/api/auth/callback`;

/** Feishu sign-in is offered only when its app is configured. */
export function feishuLoginConfigured(): boolean {
  return !!credential("integrations", "FEISHU_LOGIN_APP_ID") && !!credential("integrations", "FEISHU_LOGIN_APP_SECRET");
}

export interface AdminPrincipal {
  userId: number | null;
  name: string;
  csrf: string;
  dev: boolean;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value).slice(i + 1));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A damaged cookie (including another application's cookie) is not an outage.
    }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Where to send the browser to sign in; the signed state also carries where to return. */
export function loginRedirect(returnTo: string): { url: string; stateCookie: string } {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const state = `${randomBytes(16).toString("base64url")}|${safeReturn(returnTo)}`;
  const url = `https://passport.feishu.cn/suite/passport/oauth/authorize?${new URLSearchParams({ client_id: appId, redirect_uri: CALLBACK_URL, response_type: "code", state: sign(state) })}`;
  return { url, stateCookie: sign(state) };
}

/** Only admin paths on this site; anything else (other hosts, protocol-relative) falls back to /admin. */
export function safeReturn(target: string): string {
  let path = target;
  // A proxy's login redirect may pass the whole original URL; keep only its path and query.
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch {
      return "/admin";
    }
  }
  return /^\/admin(\/|\?|$)/.test(path) && !path.startsWith("//") ? path : "/admin";
}

interface FeishuUser {
  union_id?: string;
  email?: string;
  enterprise_email?: string;
  name?: string;
}

async function feishuUser(code: string): Promise<FeishuUser> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu login app is not configured");
  const tokenRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: CALLBACK_URL }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`Feishu token exchange failed: ${token.error ?? tokenRes.status}`);
  const userRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await userRes.json()) as FeishuUser;
}

export class LoginRejected extends Error {}

type AuthMethod = "password" | "feishu";

/** Bind opaque sessions to the active credentials without storing a password or provider secret. */
function sessionVersion(method: AuthMethod, password = config.adminPassword): string | null {
  const signingSecret = credential("auth", "SESSION_SECRET");
  if (!signingSecret) return null;
  let inputs: string[];
  if (method === "password") {
    if (!password || password.length < 12) return null;
    inputs = [password];
  } else {
    const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
    const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
    if (!appId || !appSecret) return null;
    inputs = [appId, appSecret];
  }
  return createHmac("sha256", signingSecret).update(JSON.stringify(["admin-session", 1, method, ...inputs])).digest("hex");
}

function sameVersion(given: string | null, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function createSession(userId: number, userAgent: string | undefined, method: AuthMethod, version: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, credential_version)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null}, ${method}, ${version})`;
  return token;
}

/** OAuth callback: verify state, identify the Feishu user, admit only allowlisted admins. */
export async function completeLogin(code: string, state: string, stateCookie: string | undefined, userAgent: string | undefined) {
  const expected = unsign(stateCookie);
  const given = unsign(state);
  if (!expected || !given || expected !== given) throw new LoginRejected("登录状态已失效，请重新登录");
  const returnTo = given.split("|")[1] ?? "/admin";
  const u = await feishuUser(code);
  const email = (u.enterprise_email ?? u.email ?? "").toLowerCase() || null;
  const allowed = (u.union_id && config.adminUnionIds.includes(u.union_id)) || (email && config.adminEmails.includes(email));
  if (!allowed) throw new LoginRejected("这个飞书账号没有后台权限");
  const [existing] = await sql<{ id: number }[]>`
    SELECT id FROM admin_users WHERE (${u.union_id ?? null}::text IS NOT NULL AND feishu_union_id = ${u.union_id ?? null}) OR (${email}::text IS NOT NULL AND email = ${email}) LIMIT 1`;
  const [user] = existing
    ? await sql<{ id: number }[]>`UPDATE admin_users SET feishu_union_id = coalesce(feishu_union_id, ${u.union_id ?? null}), email = coalesce(email, ${email}),
        display_name = coalesce(${u.name ?? null}, display_name), last_login_at = now() WHERE id = ${existing.id} RETURNING id`
    : await sql<{ id: number }[]>`INSERT INTO admin_users (feishu_union_id, email, display_name, last_login_at) VALUES (${u.union_id ?? null}, ${email}, ${u.name ?? null}, now()) RETURNING id`;
  const version = sessionVersion("feishu");
  if (!version) throw new LoginRejected("飞书登录配置已失效，请联系管理员");
  const token = await createSession(user!.id, userAgent, "feishu", version);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { union_id: u.union_id ?? null });
  return { token, returnTo, userId: user!.id };
}

/** The single password admin: one row, found by its reserved address. */
const PASSWORD_ADMIN = "admin@local";

/** Password sign-in: a constant-time comparison of digests, so the length leaks nothing either. */
export async function passwordLogin(password: string, returnTo: string, userAgent: string | undefined) {
  const expected = config.adminPassword;
  if (!expected || expected.length < 12) throw new LoginRejected("还没有设置管理员密码（环境变量 ADMIN_PASSWORD，至少 12 位）");
  const version = sessionVersion("password", expected);
  if (!version) throw new Error("SESSION_SECRET is not configured");
  const given = createHmac("sha256", "admin-password").update(password).digest();
  const wanted = createHmac("sha256", "admin-password").update(expected).digest();
  if (!timingSafeEqual(given, wanted)) throw new LoginRejected("密码不对");
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, display_name, last_login_at) VALUES (${PASSWORD_ADMIN}, '管理员', now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`;
  const token = await createSession(user!.id, userAgent, "password", version);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { method: "password" });
  return { token, returnTo: safeReturn(returnTo), userId: user!.id };
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const [row] = await sql<{
      user_id: number; csrf_token: string; name: string | null; email: string | null;
      feishu_union_id: string | null; auth_method: AuthMethod | null; credential_version: string | null;
    }[]>`
      SELECT s.user_id, s.csrf_token, u.display_name AS name, u.email, u.feishu_union_id, s.auth_method, s.credential_version
      FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id_hash = ${sha256(token)} AND s.expires_at > now()`;
    if (row && (row.auth_method === "password" || row.auth_method === "feishu") && sameVersion(row.credential_version, sessionVersion(row.auth_method))) {
      const allowed = row.auth_method === "password" ? row.email === PASSWORD_ADMIN
        : !!((row.feishu_union_id && config.adminUnionIds.includes(row.feishu_union_id)) || (row.email && config.adminEmails.includes(row.email.toLowerCase())));
      if (allowed) return { userId: row.user_id, name: row.name ?? row.email ?? `admin:${row.user_id}`, csrf: row.csrf_token, dev: false };
    }
  }
  if (config.devAdmin && config.environmentName !== "production") return { userId: null, name: config.devAdmin.displayName, csrf: "dev", dev: true };
  return null;
}

export async function endSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await sql`DELETE FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
}

/** The authenticated user revokes all of their devices; the API requires their session CSRF token. */
export async function endAllSessions(admin: AdminPrincipal): Promise<number> {
  if (admin.dev || admin.userId === null) throw Object.assign(new Error("A real admin session is required."), { statusCode: 400 });
  return sql.begin(async (tx) => {
    const removed = await tx`DELETE FROM admin_sessions WHERE user_id = ${admin.userId} RETURNING id_hash`;
    await tx`INSERT INTO audit_log (actor, action, subject, before, after)
      VALUES (${actorOf(admin)}, 'auth.logout_all', ${`admin:${admin.userId}`}, ${tx.json({ sessions: removed.length })}, ${tx.json({ sessions: 0 })})`;
    return removed.length;
  });
}

/** Every manual change: who, when, what, why. */
export async function audit(actor: string, action: string, subject: string | null, reason: string | null, before: unknown, after: unknown, requestId?: string) {
  await sql`INSERT INTO audit_log (actor, action, subject, reason, before, after, request_id)
            VALUES (${actor}, ${action}, ${subject}, ${reason}, ${before === null || before === undefined ? null : sql.json(before as never)},
                    ${after === null || after === undefined ? null : sql.json(after as never)}, ${requestId ?? null})`;
}

export function actorOf(p: AdminPrincipal): string {
  return p.dev ? `dev:${p.name}` : `admin:${p.userId}`;
}
