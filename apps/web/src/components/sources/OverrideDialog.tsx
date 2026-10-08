import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/api/client";
import { useCategories, useClearSourceOverride, useSetSourceOverride } from "@/api/queries";
import type { SourceLeaf } from "@feedhound/core/source-classify";

const KEEP = "__keep";

export function OverrideDialog({ leaf, regions, onClose }: { leaf: SourceLeaf; regions: string[]; onClose: () => void }) {
  const { data: categories } = useCategories();
  const set = useSetSourceOverride();
  const clear = useClearSourceOverride();
  const [topic, setTopic] = useState<string>(leaf.override.topicCategoryId ?? KEEP);
  const [region, setRegion] = useState<string>(leaf.override.region ?? "");
  const hasOverride = leaf.override.topicCategoryId !== null || leaf.override.region !== null;
  const error = set.error ?? clear.error;
  const busy = set.isPending || clear.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override group: {leaf.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="override-topic">Topic</Label>
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger id="override-topic">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>Automatic</SelectItem>
              {(categories ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="override-region">Region (province)</Label>
          <Input id="override-region" list="override-regions" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Automatic" />
          <datalist id="override-regions">
            {regions.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error instanceof ApiError ? `Could not save override (${error.message})` : "Could not save override"}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={async () => {
              await set.mutateAsync({
                id: leaf.id,
                topicCategoryId: topic === KEEP ? null : topic,
                region: region.trim() === "" ? null : region.trim(),
              });
              onClose();
            }}
          >
            {set.isPending ? "Saving…" : "Save"}
          </Button>
          {hasOverride ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                await clear.mutateAsync(leaf.id);
                onClose();
              }}
            >
              Clear override
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
