import type { FastifyInstance, FastifyRequest } from "fastify";
import { FeedbackRejected, feedbackSourceHash, submitFeedback, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { feedbackLimits } from "@aihot/backend/operations/feedback-abuse";
import { sendProblem } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot" | "submissionId" | "allowLegacyGif">;

async function readBody(raw: unknown, contentType: string): Promise<FeedbackBody> {
  if (Buffer.isBuffer(raw)) {
    let form: FormData;
    try {
      form = await new Response(raw as Buffer<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确，请重新提交。");
    }
    const text = (key: string) => {
      if (form.getAll(key).length > 1) throw new FeedbackRejected(400, "invalid_request", "反馈字段不能重复。");
      const value = form.get(key);
      if (value !== null && typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈文字格式不正确。");
      return value;
    };
    const file = form.get("screenshot");
    if (form.getAll("screenshot").length > 1) throw new FeedbackRejected(400, "invalid_request", "每条反馈只能附一张截图。");
    if (file !== null && !(file instanceof File)) throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确。");
    return {
      content: text("content") ?? "", email: text("email"), pageUrl: text("pageUrl"),
      submissionId: text("submissionId"),
      screenshot: file ? { mime: file.type, data: Buffer.from(await file.arrayBuffer()) } : null,
    };
  }
  // Keep already-open browser tabs working during a release: their JSON/base64 requests still work.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FeedbackRejected(400, "invalid_request", "反馈格式不正确。");
  const body = raw as { content?: string; email?: string; pageUrl?: string; submissionId?: string; screenshot?: { mime?: string; data?: string } };
  if (body.screenshot && (typeof body.screenshot !== "object" || typeof body.screenshot.data !== "string" || typeof body.screenshot.mime !== "string")) throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确。");
  return {
    content: body.content ?? "", email: body.email ?? null, pageUrl: body.pageUrl ?? null, submissionId: body.submissionId ?? null,
    screenshot: body.screenshot?.data && body.screenshot.mime ? { mime: body.screenshot.mime, data: Buffer.from(body.screenshot.data, "base64") } : null,
    allowLegacyGif: true,
  };
}

export function registerFeedback(app: FastifyInstance) {
  let active = 0;
  const bySource = new Map<string, number>();
  const admitted = new WeakMap<FastifyRequest, { source: string; timer: ReturnType<typeof setTimeout>; bodyDone: () => void }>();
  const release = (req: FastifyRequest) => {
    const slot = admitted.get(req);
    if (!slot) return;
    admitted.delete(req);
    clearTimeout(slot.timer);
    req.raw.removeListener("end", slot.bodyDone);
    active -= 1;
    const count = (bySource.get(slot.source) ?? 1) - 1;
    if (count > 0) bySource.set(slot.source, count); else bySource.delete(slot.source);
  };
  app.addHook("onResponse", async (req) => { release(req); });
  app.addHook("onRequestAbort", async (req) => { release(req); });
  // Bounded by the same request limit as JSON; native multipart parsing avoids base64 on the wire.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/api/site/feedback", {
    // JSON/base64 and multipart remain supported; refuse excess concurrent bodies before parsing.
    bodyLimit: 8 * 1024 * 1024,
    onRequest: async (req, reply) => {
      const limits = feedbackLimits(), source = feedbackSourceHash(req.ip);
      if (active >= limits.concurrent || (bySource.get(source) ?? 0) >= limits.perIpConcurrent) {
        reply.header("Connection", "close");
        return sendProblem(req, reply, { status: 429, code: "busy", detail: "反馈服务正忙，请稍后重试。", retryAfter: 10 });
      }
      active += 1;
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
      const timer = setTimeout(() => {
        if (req.raw.complete || reply.sent) return;
        release(req);
        reply.header("Connection", "close");
        reply.raw.once("finish", () => req.raw.destroy());
        void sendProblem(req, reply, { status: 408, code: "request_timeout", detail: "截图上传超过等待期限，请检查网络后重试。", retryAfter: 5 });
      }, limits.bodyTimeoutMs);
      timer.unref();
      const bodyDone = () => clearTimeout(timer);
      admitted.set(req, { source, timer, bodyDone });
      req.raw.once("end", bodyDone);
    },
  }, async (req, reply) => {
    try {
      const body = await readBody(req.body, String(req.headers["content-type"] ?? ""));
      const ip = req.ip;
      const result = await submitFeedback({ ...body, ip, userAgent: String(req.headers["user-agent"] ?? "") });
      return reply.header("Cache-Control", "no-store").code(201).send(result);
    } catch (error) {
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    } finally {
      release(req);
    }
  });
}
