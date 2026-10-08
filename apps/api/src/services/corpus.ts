import { postFingerprint } from "@feedhound/core/fingerprint";
import { repostKey } from "@feedhound/core/listing";
import { comparableText, normalizeText } from "@feedhound/core/normalize";
import { splitTitle } from "@feedhound/core/title";
import { createLogger } from "@feedhound/core/logger";
import type { ServerRawPost } from "@feedhound/core/sources";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "api" });

export interface IngestResult {
  accepted: number;
  duplicates: number;
  updated: number;
}

const ENRICH_QUEUE = "enrich";
let enrichQueueReady: Promise<void> | undefined;

const MATCH_QUEUE = "match";
let matchQueueReady: Promise<void> | undefined;

/** Creates the `match` pg-boss queue once per process; idempotent across calls/processes. */
function ensureMatchQueue(boss: PgBoss): Promise<void> {
  matchQueueReady ??= boss.createQueue(MATCH_QUEUE).catch((err: unknown) => {
    matchQueueReady = undefined;
    throw err;
  });
  return matchQueueReady;
}

/**
 * `corpus.ts` enqueues `match { postId, trigger: 'ingest' }`
 * after every Post insert / text-change revision (the `enrich` trigger is
 * enqueued separately by `apps/agent/src/jobs/enrich.ts` — not yet implemented). `retryLimit 3`, `expireInSeconds 60`.
 */
async function enqueueMatch(boss: PgBoss | undefined, postId: string): Promise<void> {
  if (!boss) return;
  await ensureMatchQueue(boss);
  await boss.send(
    MATCH_QUEUE,
    { postId, trigger: "ingest" },
    { retryLimit: 3, expireInSeconds: 60 },
  );
}

// The codebase has no metrics exporter yet, so "expose a
// counter" means this in-process counter (inspectable via
// `getEnrichEnqueueFailureCount`) plus an error-level log per failure. A post
// whose enqueue fails here has no `enrich` job and won't be matched until
// something re-enqueues it.
// The agent's `reconcile` cron re-sends the enrich job for any post still `pending` after 10 min.
let enrichEnqueueFailureCount = 0;

/** Count of `enqueueEnrich` failures since process start (test/ops visibility). */
export function getEnrichEnqueueFailureCount(): number {
  return enrichEnqueueFailureCount;
}

/** Creates the `enrich` pg-boss queue once per process; idempotent across calls/processes. */
function ensureEnrichQueue(boss: PgBoss): Promise<void> {
  enrichQueueReady ??= boss.createQueue(ENRICH_QUEUE).catch((err: unknown) => {
    enrichQueueReady = undefined;
    throw err;
  });
  return enrichQueueReady;
}

async function enqueueEnrich(boss: PgBoss | undefined, postId: string, revision: number, upgrade = false): Promise<void> {
  if (!boss) return;
  await ensureEnrichQueue(boss);
  // a capture upgrade keeps the revision but must re-run enrichment on the fuller text.
  const payload = upgrade ? { postId, revision, force: true, reason: "capture_upgrade" } : { postId, revision };
  await boss.send(ENRICH_QUEUE, payload, {
    singletonKey: upgrade ? `enrich:${postId}:${revision}:upgrade` : `enrich:${postId}:${revision}`,
    retryLimit: 3,
    retryBackoff: true,
  });
}

/** First line, joined with following lines (" · ") until 40 code points, cut to 80 code points. */
export function deriveTitle(text: string): string {
  return splitTitle(text).title;
}

/**
 * Upserts `posts` for `sourceId` (new
 * `platformPostId` -> insert Post + enqueue `enrich`; existing with changed
 * text -> insert PostRevision, bump editCount, enqueue `enrich` again;
 * existing with unchanged text -> refresh lastSeenAt/engagement only.
 * Idempotent: replaying the same batch enqueues no further jobs.
 */
type PostOutcome =
  | { kind: "duplicate" }
  | { kind: "inserted"; postId: string; revision: number }
  | { kind: "updated"; postId: string; revision: number; upgrade?: true };

type PostRow = typeof schema.post.$inferSelect;
type Tx = Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0];

/** Capture precedence: text from a server-side connector (`api`) is authoritative (rank 2); pushed text ranks 1. */
function captureRank(capture: string | null | undefined): number {
  return capture === "api" ? 2 : 1;
}

/** Fill `posted_at` / `author_id` / `capture` when the row has none and the incoming post carries one. */
function fillMissing(existing: PostRow, raw: ServerRawPost): Partial<typeof schema.post.$inferInsert> {
  const fill: Partial<typeof schema.post.$inferInsert> = {};
  if (existing.postedAt === null && raw.postedAt !== undefined) fill.postedAt = new Date(raw.postedAt);
  if (existing.authorId === null && raw.authorId !== undefined) fill.authorId = raw.authorId;
  if (existing.capture === null && raw.capture !== undefined) fill.capture = raw.capture;
  return fill;
}

/** Update an already-located row (same text -> touch; changed text -> revision + edit count), honouring capture precedence. */
// A text change (edit or in-place upgrade) restarts the pipeline for the post; set in the same UPDATE as `text`.
const PIPELINE_RESET = {
  enrichState: "pending",
  matchState: "pending",
  pipelineVersion: sql`${schema.post.pipelineVersion} + 1`,
  pipelineAttempts: 0,
  pipelineReconciledAt: null,
  pipelineUpdatedAt: sql`now()`,
};

async function applyToExisting(tx: Tx, existing: PostRow, raw: ServerRawPost, fingerprint: string | null): Promise<PostOutcome> {
  const incomingRank = captureRank(raw.capture);
  const rowRank = captureRank(existing.capture);
  const fill = fillMissing(existing, raw);
  const rk = repostKey(raw); // Recomputed wherever the fingerprint is rewritten

  // Lower-rank capture never overwrites text (e.g. pushed text after a connector fetched the full post).
  if (incomingRank < rowRank) {
    await tx
      .update(schema.post)
      .set({ ...fill, lastSeenAt: new Date() })
      .where(eq(schema.post.id, existing.id));
    return { kind: "duplicate" };
  }

  // Emoji/whitespace/case-only differences are not edits (same normalisation as the fingerprint, full text).
  const sameText = existing.text === raw.text || comparableText(existing.text) === comparableText(raw.text);

  if (incomingRank > rowRank) {
    if (sameText) {
      await tx
        .update(schema.post)
        .set({ ...fill, capture: raw.capture ?? existing.capture, lastSeenAt: new Date(), engagement: raw.engagement ?? existing.engagement, fingerprint, repostKey: rk })
        .where(eq(schema.post.id, existing.id));
      return { kind: "duplicate" };
    }
    // In-place upgrade: not an edit (no revision, edit_count unchanged).
    const [upgraded] = await tx
      .update(schema.post)
      .set({
        ...fill,
        text: raw.text,
        title: deriveTitle(raw.text),
        textNormalized: normalizeText(raw.text).nfc,
        capture: raw.capture ?? existing.capture,
        lastSeenAt: new Date(),
        engagement: raw.engagement ?? existing.engagement,
        fingerprint,
        repostKey: rk,
        raw,
        ...PIPELINE_RESET,
      })
      .where(and(eq(schema.post.id, existing.id), eq(schema.post.text, existing.text)))
      .returning({ id: schema.post.id, editCount: schema.post.editCount });
    if (!upgraded) return { kind: "duplicate" };
    return { kind: "updated", postId: upgraded.id, revision: upgraded.editCount, upgrade: true };
  }

  if (sameText) {
    await tx
      .update(schema.post)
      .set({ ...fill, lastSeenAt: new Date(), engagement: raw.engagement ?? existing.engagement, fingerprint, repostKey: rk })
      .where(eq(schema.post.id, existing.id));
    return { kind: "duplicate" };
  }

  await tx.insert(schema.postRevision).values({
    postId: existing.id,
    text: existing.text,
    engagement: existing.engagement,
  });

  const [updatedRow] = await tx
    .update(schema.post)
    .set({
      ...fill,
      text: raw.text,
      title: deriveTitle(raw.text),
      textNormalized: normalizeText(raw.text).nfc,
      lastSeenAt: new Date(),
      engagement: raw.engagement ?? existing.engagement,
      editCount: sql`${schema.post.editCount} + 1`,
      fingerprint,
      repostKey: rk,
      raw,
      ...PIPELINE_RESET,
    })
    // Atomic guard: only apply this edit if the text still differs from
    // what we just read; a concurrent transaction that already applied
    // the same edit would make this a no-op duplicate instead of a
    // double-counted revision.
    .where(and(eq(schema.post.id, existing.id), eq(schema.post.text, existing.text)))
    .returning({ id: schema.post.id, editCount: schema.post.editCount });

  if (!updatedRow) return { kind: "duplicate" };
  return { kind: "updated", postId: updatedRow.id, revision: updatedRow.editCount };
}

async function findExact(tx: Tx, sourceId: string, platformPostId: string): Promise<PostRow | undefined> {
  const [row] = await tx
    .select()
    .from(schema.post)
    .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, platformPostId)))
    .for("update")
    .limit(1);
  return row;
}

/**
 * Writes one `ServerRawPost` inside its own transaction (code-review finding #5):
 * `SELECT ... FOR UPDATE` serializes concurrent ingests of the same
 * `(sourceId, platformPostId)`, and the edit-path update is additionally
 * guarded by `WHERE text <> new text` so a race can't double-count
 * `editCount` or insert two revisions for the same edit.
 *
 * Identity: reads only `ServerRawPost` fields + `scopeId`, never how the post was captured.
 */
async function writePost(handle: DbHandle, sourceId: string, scopeId: string, raw: ServerRawPost): Promise<PostOutcome> {
  const fingerprint = postFingerprint({ scopeId, authorId: raw.authorId, authorName: raw.authorName, text: raw.text });

  return handle.db.transaction(async (tx) => {
    if (fingerprint !== null) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${sourceId}:${fingerprint}`}, 0))`);
    }

    const existing = await findExact(tx, sourceId, raw.platformPostId);
    if (existing) return applyToExisting(tx, existing, raw, fingerprint);

    const [inserted] = await tx
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: raw.platformPostId,
        url: raw.url,
        authorName: raw.authorName ?? null,
        authorId: raw.authorId ?? null,
        title: deriveTitle(raw.text),
        text: raw.text,
        textNormalized: normalizeText(raw.text).nfc,
        media: raw.media,
        engagement: raw.engagement ?? {},
        fingerprint,
        repostKey: repostKey(raw),
        capture: raw.capture ?? null,
        postedAt: raw.postedAt !== undefined ? new Date(raw.postedAt) : null,
        raw,
      })
      // Race guard: a concurrent ingest for the same (sourceId, platformPostId)
      // may win the insert between our select and this insert.
      .onConflictDoNothing({ target: [schema.post.sourceId, schema.post.platformPostId] })
      .returning({ id: schema.post.id });

    if (!inserted) return { kind: "duplicate" };
    return { kind: "inserted", postId: inserted.id, revision: 0 };
  });
}

export async function ingestPosts(
  handle: DbHandle,
  boss: PgBoss | undefined,
  sourceId: string,
  posts: ServerRawPost[],
): Promise<IngestResult> {
  const [source] = await handle.db
    .select({ platformId: schema.source.platformId })
    .from(schema.source)
    .where(eq(schema.source.id, sourceId))
    .limit(1);
  if (!source) throw new Error(`ingestPosts: source ${sourceId} not found`);
  const scopeId = source.platformId;

  let accepted = 0;
  let duplicates = 0;
  let updated = 0;

  for (const raw of posts) {
    const outcome = await writePost(handle, sourceId, scopeId, raw);

    if (outcome.kind === "duplicate") {
      duplicates++;
      continue;
    }
    if (outcome.kind === "inserted") accepted++;
    else updated++;

    // Enqueue after the transaction commits: the post/revision write is
    // already durable at this point. Not a full transactional outbox (out
    // of this round's scope) — a failed enqueue is logged rather than
    // failing the ingest, so a queue hiccup never loses/duplicates corpus
    // data, only (rarely) delays enrichment of one post.
    try {
      await enqueueEnrich(boss, outcome.postId, outcome.revision, outcome.kind === "updated" && outcome.upgrade === true);
    } catch (err) {
      enrichEnqueueFailureCount++;
      logger.error(
        { err, postId: outcome.postId, revision: outcome.revision, enrichEnqueueFailureCount },
        "failed to enqueue enrich job after commit; post has no enrich job until reconciled",
      );
    }

    // Enqueue `match {trigger:'ingest'}` too, independent of the
    // enrich enqueue above (a failure here must not roll back the ingest;
    // logged the same way as the enrich enqueue failure).
    try {
      await enqueueMatch(boss, outcome.postId);
    } catch (err) {
      logger.error({ err, postId: outcome.postId }, "failed to enqueue match {trigger:'ingest'} job after commit");
    }
  }

  return { accepted, duplicates, updated };
}
