import { Card } from "@/components/layout/Card";
import type { DecisionDto } from "@/api/decision";

export function SpecBlock({ specs }: { specs: DecisionDto["specs"] }) {
  if (specs.length === 0) return null;
  return (
    <Card title="Specs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        {specs.map((s) => (
          <div key={s.key} data-spec={s.key} className="min-w-0">
            <dt className="text-fs-sm text-muted-foreground">{s.label}</dt>
            <dd className="break-words">{s.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
