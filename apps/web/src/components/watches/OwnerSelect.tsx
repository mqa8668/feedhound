import type { UserDto } from "@/api/types";

export interface OwnerSelectProps {
  users: UserDto[];
  value: string;
  onChange: (userId: string) => void;
  id: string;
}

/** Operator-only owner picker: team users, with " · Telegram" on those with a linked chat. */
export function OwnerSelect({ users, value, onChange, id }: OwnerSelectProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        Owner
      </label>
      <select
        id={id}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.email}
            {u.telegramChatId ? " · Telegram" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
