import { lazy, Suspense } from "react";
import { platformOfUrl } from "@feedhound/core/platform";
import { Link, useParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/layout/Card";
import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { PageHeader } from "@/components/layout/PageHeader";
import { ApiError } from "@/api/client";
import { useMe, usePost } from "@/api/queries";
import { useDecision } from "@/api/decision";
import { VerdictHeader } from "@/components/deal/VerdictHeader";
import { SpecBlock } from "@/components/deal/SpecBlock";
import { ComparablesTable } from "@/components/deal/ComparablesTable";
import { WatchFitList } from "@/components/deal/WatchFitList";
import { SellerPanel } from "@/components/deal/SellerPanel";
import { formatAbsolute, formatPrice, formatPriceQualified, INTENT_VARIANT } from "@/lib/format";

// Recharts stays out of the page chunk.
const PriceDistributionChart = lazy(() => import("@/components/deal/PriceDistributionChart"));

/** Decision blocks. Renders nothing while loading or when the endpoint is unavailable. */
function DealVerdictSection({ postId, url }: { postId: string; url: string }) {
  const { data } = useDecision(postId);
  if (!data || !data.verdict) return null;
  return (
    <div className="flex flex-col gap-4">
      <VerdictHeader postId={postId} url={url} decision={data} />
      <SpecBlock specs={data.specs ?? []} />
      {data.distribution ? (
        <Card title="Price vs market">
          <Suspense fallback={<div className="h-32 animate-pulse rounded bg-muted" />}>
            <PriceDistributionChart distribution={data.distribution} priceVnd={data.price.vnd} percentile={data.percentile} />
          </Suspense>
        </Card>
      ) : null}
      <ComparablesTable rows={data.comparables ?? []} />
      <WatchFitList fit={data.fit ?? []} />
      {data.seller ? <SellerPanel seller={data.seller} /> : null}
    </div>
  );
}

interface MediaItem {
  type: "image" | "video";
  url: string;
}

/** Only `{ type: "image" | "video", url: http(s) URL }` items render; anything else is skipped silently. */
function parseMedia(media: unknown[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of media) {
    if (typeof m !== "object" || m === null) continue;
    const { type, url } = m as { type?: unknown; url?: unknown };
    if ((type !== "image" && type !== "video") || typeof url !== "string") continue;
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") out.push({ type, url });
    } catch {
      // malformed URL: skip
    }
  }
  return out;
}

function MediaImage({ url }: { url: string }) {
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-h-80 rounded border object-contain"
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="post-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted" />
      ))}
    </div>
  );
}

/** Post permalink: text + edit history, media, enrichment, matches, cross-source duplicates. */
export default function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch } = usePost(id);
  const { data: me } = useMe();

  if (isLoading) return <Skeleton />;
  if (isError || !data) {
    if (error instanceof ApiError && error.status === 404) return <EmptyState title="Post not found" description="It may belong to another team or no longer exist." />;
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const { post, source, revisions, enrichment, matches, duplicates, pipeline } = data;
  const title = post.title ?? (post.text.slice(0, 80) || "(untitled post)");
  const media = parseMedia(post.media);
  const isOperator = me?.role === "operator";
  const when = post.postedAt ?? post.firstSeenAt;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{source.name}</span>
        {post.authorName ? (
          <span>
            by{" "}
            {post.authorName}
          </span>
        ) : null}
        <span>{formatAbsolute(when)}</span>
        {post.capture ? <Badge variant="outline">{post.capture}</Badge> : null}
        <span>
          {post.editCount} edit{post.editCount === 1 ? "" : "s"}
        </span>
        <a href={post.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
          {platformOfUrl(post.url).openLabel} <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>

      <DealVerdictSection postId={post.id} url={post.url} />

      <Card title="Text">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Current &middot; {formatAbsolute(post.lastSeenAt)}</p>
            <p className="whitespace-pre-wrap text-sm">{post.text}</p>
          </div>
          {revisions.length > 0 ? (
            <div className="flex flex-col gap-3 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Edit history ({revisions.length})</p>
              {revisions.map((r) => (
                <div key={r.id}>
                  <p className="mb-1 text-xs text-muted-foreground">{formatAbsolute(r.seenAt)}</p>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{r.text}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      {media.length > 0 ? (
        <Card title="Media">
          <div className="flex flex-wrap gap-3">
            {media.map((m, i) =>
              m.type === "image" ? (
                <MediaImage key={`${i}-${m.url}`} url={m.url} />
              ) : (
                <a key={`${i}-${m.url}`} href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm hover:underline">
                  Video <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ),
            )}
          </div>
        </Card>
      ) : null}

      <Card title="Enrichment">
        {enrichment ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Intent</dt>
              <dd>{enrichment.intent ? <Badge variant={INTENT_VARIANT[enrichment.intent] ?? "secondary"}>{enrichment.intent}</Badge> : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Price</dt>
              <dd className="tabular-nums">
                {enrichment.priceVnd == null ? formatPrice(null) : formatPriceQualified(enrichment.priceVnd, enrichment.priceQualifier, enrichment.priceMaxVnd)}
                {enrichment.priceRaw ? <span className="text-xs text-muted-foreground"> ({enrichment.priceRaw})</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Condition</dt>
              <dd>{enrichment.condition ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Category</dt>
              <dd>{enrichment.category ? enrichment.category.name : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Item</dt>
              <dd>{enrichment.item ? enrichment.item.name : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Sentiment / tags</dt>
              <dd className="flex flex-wrap gap-1" data-testid="enrichment-tags">
                {enrichment.sentiment ? <Badge variant="outline">{enrichment.sentiment}</Badge> : null}
                {(enrichment.intentTags ?? []).map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                {!enrichment.sentiment && (enrichment.intentTags ?? []).length === 0 ? "—" : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Engine</dt>
              <dd>
                {enrichment.engine}
                {enrichment.model ? ` · ${enrichment.model}` : ""}
                {enrichment.confidence != null ? ` · ${Math.round(enrichment.confidence * 100)}%` : ""}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Not enriched yet.</p>
        )}
      </Card>

      <Card title="Matches">
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches on your watches.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Watch</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Matched terms</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matches.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link to={`/watches/${m.watchId}`} className="hover:underline">
                      {m.watchName}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">{m.score.toFixed(2)}</TableCell>
                  <TableCell>{m.matchedTerms.join(", ")}</TableCell>
                  <TableCell>{formatAbsolute(m.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card title="Also seen in">
        {duplicates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No copies in other groups.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {duplicates.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <Link to={`/posts/${d.id}`} className="truncate hover:underline">
                  {d.sourceName}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{formatAbsolute(d.firstSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isOperator && pipeline ? (
        <Card title="Pipeline">
          <p className="text-sm text-muted-foreground">
            enrich: {pipeline.enrichState} &middot; match: {pipeline.matchState} &middot; version {pipeline.pipelineVersion}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
