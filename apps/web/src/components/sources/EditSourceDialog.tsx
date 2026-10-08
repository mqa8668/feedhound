import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScheduleEditor, type ScheduleValue } from "@/components/ScheduleEditor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useKeys, usePatchSource } from "@/api/queries";
import type { ApiKeyDto, SourceDto } from "@/api/types";

const NONE = "none";

/** Ingest keys usable for assignment: not revoked, carry the `ingest` scope. */
function ingestKeys(keys: ApiKeyDto[] | undefined): ApiKeyDto[] {
  return (keys ?? []).filter((k) => !k.revokedAt && k.scopes.includes("ingest"));
}

export function EditSourceDialog({ source, onClose }: { source: SourceDto; onClose: () => void }) {
  const patchSource = usePatchSource();
  const { data: keys, isError: keysError } = useKeys();
  const [schedule, setSchedule] = useState<ScheduleValue | null>(source.schedule);
  const [assignedKeyId, setAssignedKeyId] = useState<string | null>(source.assignedKeyId);

  const isWeb = source.kind === "web";
  const availableKeys = ingestKeys(keys);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {source.name}</DialogTitle>
        </DialogHeader>
        <ScheduleEditor value={schedule ?? source.schedule} onChange={setSchedule} />
        {isWeb ? null : (
        <div className="mt-4 space-y-1">
          <Label htmlFor="source-key">Assigned ingest key</Label>
          <Select
            value={assignedKeyId ?? NONE}
            onValueChange={(v) => setAssignedKeyId(v === NONE ? null : v)}
          >
            <SelectTrigger id="source-key">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None (cannot ingest)</SelectItem>
              {availableKeys.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.name} ({k.prefix})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {keysError ? (
            <p className="text-sm text-destructive">Could not load ingest keys — the current assignment is preserved, but you cannot pick another key right now.</p>
          ) : null}
        </div>
        )}
        <Button
          className="mt-4"
          onClick={async () => {
            await patchSource.mutateAsync({
              id: source.id,
              schedule: schedule ?? source.schedule,
              ...(isWeb ? {} : { assignedKeyId }),
            });
            onClose();
          }}
          disabled={patchSource.isPending}
        >
          {patchSource.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
