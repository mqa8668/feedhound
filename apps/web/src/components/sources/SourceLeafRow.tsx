import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { formatDateCell } from "@/lib/format";
import type { SourceLeaf } from "@feedhound/core/source-classify";
import type { ApiKeyDto, SourceDto } from "@/api/types";

const METHOD_LABEL: Record<string, string> = {
  auto: "Auto",
  mixed: "Mixed",
  default: "Default",
  insufficient: "Insufficient",
  none: "None",
  override: "Override",
};

export function methodBadge(leaf: SourceLeaf, minPosts: number): string {
  if (leaf.topic.method === "insufficient") return `Insufficient data (${leaf.sampleN}/${minPosts})`;
  return METHOD_LABEL[leaf.topic.method] ?? leaf.topic.method;
}

export function SourceLeafRow({
  leaf,
  minPosts,
  detail,
  keys,
  keysError,
  operator,
  onEdit,
  onToggle,
  onOverride,
}: {
  leaf: SourceLeaf;
  minPosts: number;
  detail: SourceDto | undefined;
  keys: ApiKeyDto[] | undefined;
  keysError: boolean;
  operator: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onOverride: () => void;
}) {
  const share = leaf.relevance7d.share;
  const visit = formatDateCell(detail?.health.lastVisitAt);
  const key = detail?.assignedKeyId ? keys?.find((k) => k.id === detail.assignedKeyId) : undefined;
  return (
    <li className="flex flex-col gap-2 border-b border-border py-2 pl-9 pr-3 sm:pl-[4.5rem]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-sm">{leaf.name}</span>
        <StatusBadge status={leaf.status} />
        {leaf.health === "stale" ? <StatusBadge status="unknown">stale</StatusBadge> : null}
        <Badge variant="outline">{methodBadge(leaf, minPosts)}</Badge>
        <span className="text-sm tabular-nums" title="Relevance share, last 7 days">
          {share == null ? "–" : `${Math.round(share * 100)}%`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {detail ? (
          detail.kind === "web" ? (
            <span>Server poll</span>
          ) : !detail.assignedKeyId ? (
            <StatusBadge status="error">No key assigned</StatusBadge>
          ) : keysError ? (
            <StatusBadge status="error">Key lookup failed</StatusBadge>
          ) : (
            <span className="font-mono">{key ? `${key.name} (${key.prefix})` : detail.assignedKeyId}</span>
          )
        ) : null}
        <span title={visit.absolute}>Last visit {visit.relative}</span>
        <span>{detail?.health.postsLastHour ?? 0} posts/hr</span>
        {detail?.health.reason ? <span className="max-w-48 truncate">{detail.health.reason}</span> : null}
      </div>
      {operator ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={!detail}>
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={onToggle}>
            {leaf.status === "active" ? "Pause" : "Resume"}
          </Button>
          <Button variant="outline" size="sm" onClick={onOverride}>
            Override group
          </Button>
        </div>
      ) : null}
    </li>
  );
}
