import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SourceDto } from "@/api/types";

export type ScheduleValue = NonNullable<SourceDto["schedule"]>;

const DEFAULT_SCHEDULE: ScheduleValue = { visitEverySec: { min: 300, max: 900 } };

interface Props {
  value: ScheduleValue | null;
  onChange: (value: ScheduleValue) => void;
  idPrefix?: string;
}

/** Edits `schedule.visitEverySec.{min,max}` jsonb. */
export function ScheduleEditor({ value, onChange, idPrefix = "schedule" }: Props) {
  const current = value ?? DEFAULT_SCHEDULE;
  const min = current.visitEverySec?.min ?? 300;
  const max = current.visitEverySec?.max ?? 900;

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-min`}>Visit every (min seconds)</Label>
        <Input
          id={`${idPrefix}-min`}
          type="number"
          min={1}
          value={min}
          onChange={(e) => onChange({ ...current, visitEverySec: { min: Number(e.target.value), max } })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-max`}>Visit every (max seconds)</Label>
        <Input
          id={`${idPrefix}-max`}
          type="number"
          min={min}
          value={max}
          onChange={(e) => onChange({ ...current, visitEverySec: { min, max: Number(e.target.value) } })}
        />
      </div>
    </div>
  );
}
