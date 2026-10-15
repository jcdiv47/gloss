/**
 * Datalab, for "Read it more carefully": a hard PDF (two columns, tables,
 * maths, a scan) read again by a layout-aware parser. Server-side only.
 *
 * API v1: submit to /convert in "balanced" mode, poll the request, split the
 * paginated Markdown into pages. Image captions are off (the reader drops
 * images anyway), and so is image extraction, which would only bloat the reply.
 */

const BASE = "https://www.datalab.to/api/v1/convert";

/** Marker's page delimiter with paginate on: "{0}" then 48 dashes, before every page. */
const PAGE_BREAK = /\n*\{\d+\}-{48}\n*/;

export type Parsed = { ok: true; pages: string[]; usd: number | null } | { ok: false; error: string };

export async function parseCarefully(pdf: Blob, opts: { maxPages: number; signal?: AbortSignal; deadlineMs?: number }): Promise<Parsed> {
  const key = process.env.DATALAB_API_KEY;
  if (!key) return { ok: false, error: "Careful reading is not set up on this server." };
  const auth = { "X-API-Key": key };
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 240_000;

  const form = new FormData();
  form.append("file", pdf, "document.pdf");
  form.append("output_format", "markdown");
  form.append("mode", "balanced");
  form.append("paginate", "true");
  form.append("disable_image_captions", "true");
  form.append("disable_image_extraction", "true");
  form.append("max_pages", String(opts.maxPages));
  let check: string | undefined;
  try {
    const res = await fetch(BASE, { method: "POST", headers: auth, body: form, signal: opts.signal });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; request_id?: string; request_check_url?: string; error?: string | null };
    if (!res.ok || j.success === false || !j.request_id) return { ok: false, error: `The careful reader refused the file (${res.status}).` };
    check = j.request_check_url || `${BASE}/${j.request_id}`;
  } catch {
    return { ok: false, error: "Could not reach the careful reader." };
  }

  type Result = {
    status?: string;
    success?: boolean;
    markdown?: string | null;
    error?: string | null;
    /** Set instead of inline content when the result is stored in another region (EU). */
    result_url?: string | null;
    metadata?: { failed_pages?: number[] | null } | null;
    cost_breakdown?: { final_cost_cents?: number | null } | null;
  };
  // Poll until done, the request is cancelled, or the function would run out of time.
  let done: Result | null = null;
  while (Date.now() - started < deadline) {
    if (opts.signal?.aborted) return { ok: false, error: "Stopped." };
    await new Promise((r) => setTimeout(r, 1500));
    const s = (await fetch(check, { headers: auth, signal: opts.signal })
      .then((r) => r.json())
      .catch(() => null)) as Result | null;
    if (s?.status === "complete") {
      done = s;
      break;
    }
    if (s?.status === "failed") return { ok: false, error: s.error || "The careful reader could not read this file." };
  }
  if (!done) return { ok: false, error: "Reading carefully took too long. Try a shorter PDF." };

  if (done.result_url) {
    // A signed link, so no API key; bounded by what is left of the deadline.
    const left = deadline - (Date.now() - started);
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
    const stored = (await fetch(done.result_url, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as Result | null;
    if (!stored) return { ok: false, error: opts.signal?.aborted ? "Stopped." : "Could not download the careful reading." };
    // The polling reply's own fields (billing above all) are the current ones.
    done = { ...stored, ...Object.fromEntries(Object.entries(done).filter(([, v]) => v != null && v !== "")) };
  }
  if (done.success === false) return { ok: false, error: done.error || "The careful reader could not read this file." };
  // A reading with pages missing would silently drop them from the text it replaces.
  const failed = done.metadata?.failed_pages ?? [];
  if (failed.length) return { ok: false, error: `The careful reader could not read ${failed.length === 1 ? "page" : "pages"} ${failed.map((p) => p + 1).join(", ")}. The text is unchanged.` };

  const parts = (done.markdown ?? "").split(PAGE_BREAK);
  // The delimiter opens every page, so the text before the first one is empty.
  const pages = parts[0].trim() ? parts : parts.slice(1);
  if (!pages.some((p) => p.trim())) return { ok: false, error: "The careful reader found no text in this file." };
  const cents = done.cost_breakdown?.final_cost_cents;
  return { ok: true, pages, usd: typeof cents === "number" ? cents / 100 : null };
}
