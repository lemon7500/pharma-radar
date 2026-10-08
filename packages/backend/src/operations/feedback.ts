// Anonymous feedback uses a stable private source digest and persistent bounded admission.
import { createHmac, randomUUID } from "node:crypto";
import sharp from "sharp";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { feishuInternalEnabled, forwardFeedbackToFeishu } from "../notify/feishu.ts";
import { putDurableFile } from "./durable-files.ts";
import { cleanupFeedbackUploads, failFeedback, FEEDBACK_MAX_IMAGE_BYTES, finishFeedback, prepareFeedbackUpload, reserveFeedback } from "./feedback-abuse.ts";

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function feedbackSourceHash(ip: string, _userAgent?: string): string {
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  return `v2:${createHmac("sha256", secret).update(`feedback-source-v2\0${ip.trim().toLowerCase()}`).digest("base64url").slice(0, 24)}`;
}

/** Old bans remain effective for their original browser family; new bans cover all families. */
export function legacyFeedbackSourceHash(ip: string, userAgent: string): string {
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", secret).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

export function normalizeFeedbackPageUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "相关页面地址格式不正确。");
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > 500 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw new FeedbackRejected(400, "invalid_request", "相关页面地址格式不正确或过长。");
  try {
    const relative = raw.startsWith("/") && !raw.startsWith("//");
    const url = new URL(raw, relative ? config.siteUrl : undefined);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (relative && url.origin !== new URL(config.siteUrl).origin)) throw new Error("unsafe page URL");
    return relative ? url.pathname + url.search + url.hash : url.href;
  } catch {
    throw new FeedbackRejected(400, "invalid_request", "相关页面需要是 HTTP、HTTPS 或本站页面地址。");
  }
}

export interface FeedbackInput {
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  /** Optional for old clients; new clients reuse this UUID when retrying the same payload. */
  submissionId?: string | null;
  allowLegacyGif?: boolean;
  ip: string;
  userAgent: string;
}

async function normalizeScreenshot(input: NonNullable<FeedbackInput["screenshot"]>, legacyGif: boolean): Promise<{ data: Buffer; mime: string; extension: string }> {
  const type = input.mime.slice("image/".length);
  try {
    const image = sharp(input.data, { limitInputPixels: 20_000_000, failOn: "warning", animated: true }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    if (metadata.format !== type || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) > 1) throw new Error("unsupported screenshot");
    // Sharp strips EXIF, ICC, XMP and comments by default. Decode the complete image, not its header alone.
    const converted = type === "jpeg" ? image.rotate().jpeg({ quality: 88 })
      : type === "webp" ? image.rotate().webp({ quality: 88, effort: 1 })
      : image.rotate().png({ compressionLevel: 6 });
    if (type === "gif" && !legacyGif) throw new Error("unsupported screenshot");
    const data = await converted.toBuffer();
    if (data.length > FEEDBACK_MAX_IMAGE_BYTES) throw new Error("encoded image exceeds limit");
    const extension = type === "gif" ? "png" : type;
    return { data, mime: `image/${extension}`, extension };
  } catch {
    throw new FeedbackRejected(400, "invalid_request", "截图无法读取、超过尺寸限制或包含动画，请使用不超过 5 MB 的静态 PNG、JPEG 或 WebP。");
  }
}

export async function submitFeedback(input: FeedbackInput): Promise<{ id: number }> {
  if (typeof input.content !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈文字格式不正确。");
  const content = input.content.trim();
  if (content.length < 2) throw new FeedbackRejected(400, "invalid_request", "请写下反馈内容。");
  if (content.length > 5000) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  if (input.email !== null && input.email !== undefined && typeof input.email !== "string") throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  const email = input.email?.trim() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  const pageUrl = normalizeFeedbackPageUrl(input.pageUrl);
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const submissionId = input.submissionId ?? randomUUID();
  if (typeof submissionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) throw new FeedbackRejected(400, "invalid_request", "提交编号格式不正确，请刷新页面后重试。");
  if (input.screenshot) {
    if (typeof input.screenshot.mime !== "string" || !Buffer.isBuffer(input.screenshot.data) || !/^image\/(png|jpeg|webp)$/.test(input.screenshot.mime) && !(input.allowLegacyGif && input.screenshot.mime === "image/gif")) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPEG 或 WebP。");
    if (!input.screenshot.data.length || input.screenshot.data.length > FEEDBACK_MAX_IMAGE_BYTES) throw new FeedbackRejected(400, "invalid_request", "截图原图不超过 5 MB。");
  }
  const payloadHash = sha256(JSON.stringify([content, email, pageUrl, input.screenshot?.mime ?? null, input.screenshot ? sha256(input.screenshot.data) : null]));
  const admission = await reserveFeedback(source, legacyFeedbackSourceHash(input.ip, input.userAgent), submissionId, payloadHash, input.screenshot?.data.length ?? 0);
  if ("feedbackId" in admission) return { id: admission.feedbackId };
  const { reservation } = admission;
  let storageKey: string | null = null;
  let id: number;
  try {
    let screenshotBytes = 0;
    if (input.screenshot) {
      const screenshot = await normalizeScreenshot(input.screenshot, input.allowLegacyGif ?? false);
      const candidateKey = `feedback-screenshots/${reservation.id}.${screenshot.extension}`;
      screenshotBytes = screenshot.data.length;
      await prepareFeedbackUpload(reservation, screenshotBytes, candidateKey);
      storageKey = candidateKey;
      await putDurableFile(storageKey, screenshot.data, screenshot.mime);
    }
    id = await finishFeedback(reservation, { content, email, pageUrl, screenshotKey: storageKey ? `local:${storageKey.slice("feedback-screenshots/".length)}` : null, screenshotBytes });
  } catch (error) {
    await failFeedback(reservation, storageKey).catch(() => {});
    throw error;
  }
  void forwardFeedbackToFeishu(id).catch(() => {});
  return { id };
}

/**
 * Every few minutes: feedback that did not reach the internal chat (Feishu down, a screenshot upload
 * failing) is tried again for a week. Newer than a few minutes is still being sent by its submission.
 */
export async function forwardPendingFeedback(): Promise<{ sent: number; failed: number }> {
  await cleanupFeedbackUploads();
  if (!feishuInternalEnabled()) return { sent: 0, failed: 0 };
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM feedback WHERE forwarded_at IS NULL AND forward_error IS NOT NULL
      AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '7 days'
    ORDER BY id LIMIT 20`;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if ((await forwardFeedbackToFeishu(r.id)) === "sent") sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
