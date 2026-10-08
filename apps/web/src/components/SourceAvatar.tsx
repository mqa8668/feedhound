import { avatarSlot, initials } from "@/components/feed-grammar";

// Full class strings so Tailwind can see them; index 0 = slot 1.
const AVATAR_BG = ["bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4", "bg-avatar-5", "bg-avatar-6", "bg-avatar-7", "bg-avatar-8"] as const;

export function SourceAvatar({ sourceId, name }: { sourceId: string; name: string }) {
  const slot = avatarSlot(sourceId);
  return (
    <span
      aria-hidden="true"
      data-avatar-slot={slot}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fs-sm font-semibold text-avatar-fg ${AVATAR_BG[slot - 1]}`}
    >
      {initials(name)}
    </span>
  );
}
