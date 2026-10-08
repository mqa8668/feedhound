import { MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/Icon";

/** Icon-only button: 32x32, 16 px glyph, same stroke everywhere. */
export const ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface WatchCardMenuProps {
  name: string;
  snoozed: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onSnooze1h: () => void;
  onSnoozeTomorrow: () => void;
  onUnsnooze: () => void;
  onDelete: () => void;
}

export function WatchCardMenu({ name, snoozed, onEdit, onDuplicate, onSnooze1h, onSnoozeTomorrow, onUnsnooze, onDelete }: WatchCardMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={ICON_BUTTON} aria-label={`Options for ${name}`} title="Options">
          <Icon icon={MoreHorizontal} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem onSelect={onSnooze1h}>Snooze 1 hour</DropdownMenuItem>
        <DropdownMenuItem onSelect={onSnoozeTomorrow}>Snooze until tomorrow</DropdownMenuItem>
        {snoozed ? <DropdownMenuItem onSelect={onUnsnooze}>Unsnooze</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={onDelete} className="text-bad">
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
