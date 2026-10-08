import { useNotifiers } from "@/api/queries";
import type { NotifierKindDto } from "@/api/types";

const KIND_LABEL: Record<NotifierKindDto, string> = { telegram: "Telegram" };

export interface NotifierPickerProps {
  /** Owner of the watch when it is not the caller; `undefined` = the caller. */
  ownerId?: string;
  /** "you", or the owner's email. */
  ownerLabel: string;
  value: string[];
  onChange: (ids: string[]) => void;
}

/** "Notify via": one checkbox per notifier of the watch owner; none picked = all enabled ones. */
export function NotifierPicker({ ownerId, ownerLabel, value, onChange }: NotifierPickerProps) {
  const { data } = useNotifiers(ownerId);
  const notifiers = data ?? [];
  const enabledCount = notifiers.filter((n) => n.enabled).length;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Notify via</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {notifiers.map((n) => (
          <label key={n.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={value.includes(n.id)} disabled={!n.enabled} onChange={() => toggle(n.id)} />
            {KIND_LABEL[n.kind]}
            {n.enabled ? "" : " (off)"}
          </label>
        ))}
      </div>
      {value.length === 0 ? (
        enabledCount === 0 ? (
          <p className="text-sm text-warn">No enabled notifier: matches will not be sent</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            None picked: sends to all enabled notifiers of {ownerLabel} ({enabledCount})
          </p>
        )
      ) : null}
    </fieldset>
  );
}
