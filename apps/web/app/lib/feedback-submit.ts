export interface FeedbackDraft { content: string; email: string; pageUrl: string }

/** Reuse a submission identifier after an uncertain response; changed material is a new submission. */
export class FeedbackSubmission {
  private attempt: { draft: FeedbackDraft; file: File | null; id: string } | null = null;

  async send(draft: FeedbackDraft, file: File | null, fetcher: typeof fetch = fetch, timeoutMs = 30_000): Promise<Response> {
    const previous = this.attempt;
    if (!previous || previous.file !== file || previous.draft.content !== draft.content || previous.draft.email !== draft.email || previous.draft.pageUrl !== draft.pageUrl) {
      this.attempt = { draft: { ...draft }, file, id: crypto.randomUUID() };
    }
    const form = new FormData();
    form.set("submissionId", this.attempt!.id);
    for (const [key, value] of Object.entries(draft)) form.set(key, value);
    if (file) form.set("screenshot", file);
    return fetcher("/api/site/feedback", { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  }

  complete() { this.attempt = null; }
}
