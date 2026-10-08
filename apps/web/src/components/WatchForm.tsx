import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { watchInputSchema, type WatchInput } from "@feedhound/core/watch";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/layout/Card";
import { CategoryTreePicker } from "@/components/watches/CategoryTreePicker";
import { LintList } from "@/components/watches/LintList";
import { LivePreview } from "@/components/watches/LivePreview";
import { NotifierPicker } from "@/components/watches/NotifierPicker";
import { OwnerSelect } from "@/components/watches/OwnerSelect";
import { NlInput } from "@/components/watches/NlInput";
import { Suggestions } from "@/components/watches/Suggestions";
import { UnderstoodChips, type UnderstoodValues } from "@/components/watches/UnderstoodChips";
import { useCatalogItemsByIds, useCategories, useMe, useSources, useUsers, useWatchPreview } from "@/api/queries";
import type { WatchDto, WatchParseResponseDto } from "@/api/types";
import { lintWatch, type LintItem } from "@/lib/watch-lint";
import { cn } from "@/lib/utils";

export type WatchFormValues = WatchInput;
// @hookform/resolvers@5's zodResolver types field values as the schema's
// *input* (pre-transform/defaults) shape, not its output — watchInputSchema
// applies `.default()` to several fields, so the two differ.
type WatchFormFields = z.input<typeof watchInputSchema>;

interface Props {
  defaultValues?: Partial<WatchDto>;
  /** `owner` is set only when the owner differs from the caller (create) or from the saved owner (edit). */
  onSubmit: (values: WatchFormValues, owner?: { userId: string }) => void | Promise<void>;
  /** Create: owner preselected from `?owner=` (operator only). */
  initialOwnerId?: string;
  onCancel?: () => void;
  submitLabel?: string;
  submitting?: boolean;
}

function ChipInput({ label, id, value, onChange }: { label: string; id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const term = draft.trim();
    if (term) onChange([...value, term]);
    setDraft("");
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1">
        {value.map((term, i) => (
          <span key={`${term}-${i}`} className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
            {term}
            <button
              type="button"
              aria-label={`Remove ${term}`}
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none focus-visible:ring-0"
          value={draft}
          placeholder="type and press enter"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
      </div>
    </div>
  );
}

/** Advanced opens for watches whose matching lives there: includeAll, regex, sources, or keywords with no category/item. */
function needsAdvanced(w: Partial<WatchDto> | undefined): boolean {
  if (!w) return false;
  const keywordOnly = (w.include?.length ?? 0) > 0 && (w.categoryIds?.length ?? 0) === 0 && (w.itemIds?.length ?? 0) === 0;
  return (w.includeAll?.length ?? 0) > 0 || !!w.regex || (w.sourceIds?.length ?? 0) > 0 || keywordOnly;
}

const INTENTS = ["sell", "buy", "other"] as const;

/** Form field values for a saved/draft watch: API nulls become `undefined` so the schema accepts them. */
function formDefaults(defaultValues?: Partial<WatchDto>): WatchFormFields {
  return {
    name: defaultValues?.name ?? "",
    enabled: defaultValues?.enabled ?? true,
    include: defaultValues?.include ?? [],
    includeAll: defaultValues?.includeAll ?? [],
    exclude: defaultValues?.exclude ?? [],
    regex: defaultValues?.regex ?? undefined,
    categoryIds: defaultValues?.categoryIds ?? [],
    itemIds: defaultValues?.itemIds ?? [],
    priceMin: defaultValues?.priceMin ?? undefined,
    priceMax: defaultValues?.priceMax ?? undefined,
    intents: (defaultValues?.intents as WatchFormValues["intents"]) ?? [],
    attributeFilters: defaultValues?.attributeFilters ?? [],
    sourceIds: defaultValues?.sourceIds ?? [],
    notifierIds: defaultValues?.notifierIds ?? [],
    quietHours: defaultValues?.quietHours ?? undefined,
    mutedUntil: defaultValues?.mutedUntil ?? undefined,
  };
}

export function WatchForm({ defaultValues, onSubmit, initialOwnerId, onCancel, submitLabel = "Save", submitting }: Props) {
  const { data: categories } = useCategories();
  const { data: sources } = useSources();
  const { data: me } = useMe();
  const isOperator = me?.role === "operator";
  const { data: users } = useUsers(isOperator);
  const [owner, setOwner] = useState<string | undefined>(() => initialOwnerId ?? defaultValues?.userId);
  const [savedPicks] = useState<string[]>(() => [...(defaultValues?.notifierIds ?? [])]);
  const [suggestions, setSuggestions] = useState<WatchParseResponseDto["suggestions"] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(() => needsAdvanced(defaultValues));

  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors },
    reset,
  } = useForm<WatchFormFields, unknown, WatchFormValues>({
    // Empty time inputs yield "" — an unset quiet-hours pair must reach the schema as `undefined`.
    resolver: (values, context, options) => {
      const q = values.quietHours;
      const unset = q && !q.start && !q.end;
      return zodResolver(watchInputSchema)(unset ? { ...values, quietHours: undefined } : values, context, options);
    },
    mode: "onChange",
    defaultValues: formDefaults(defaultValues),
  });

  useEffect(() => {
    if (defaultValues?.id) reset(formDefaults(defaultValues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues?.id]);

  const values = useWatch<WatchFormFields>({ control });
  const { data: items } = useCatalogItemsByIds((values.itemIds ?? []) as string[]);

  const toggleInArray = (field: "categoryIds" | "sourceIds" | "intents", value: string) => {
    const current = (values[field] ?? []) as string[];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setValue(field, next as never, { shouldValidate: true });
  };

  // Whose notifiers the picker lists, and whether saving moves an existing watch to another owner.
  const effectiveOwner = owner ?? me?.id;
  const otherOwner = effectiveOwner && me?.id && effectiveOwner !== me.id ? effectiveOwner : undefined;
  const ownerLabel = otherOwner ? (users?.find((u) => u.id === otherOwner)?.email ?? "this user") : "you";
  const isEdit = Boolean(defaultValues?.id);
  const moving = isEdit && owner !== undefined && owner !== defaultValues?.userId;
  const ownerForSubmit = isEdit ? (moving ? owner : undefined) : otherOwner;
  const changeOwner = (id: string) => {
    const original = defaultValues?.userId;
    if (original && id === original) {
      setOwner(id);
      setValue("notifierIds", savedPicks, { shouldDirty: true }); // back to the original owner: restore their picks
      return;
    }
    setOwner(id);
    setValue("notifierIds", [], { shouldDirty: true }); // picks belong to the previous owner
  };

  const setField = (field: keyof WatchFormFields, value: unknown) => setValue(field, value as never, { shouldValidate: true, shouldDirty: true });

  const applyParsed = (res: WatchParseResponseDto) => {
    const d = res.draft;
    if (!values.name) setField("name", d.name);
    setField("include", d.include);
    setField("includeAll", d.includeAll);
    setField("exclude", d.exclude);
    setField("categoryIds", d.categoryIds);
    setField("itemIds", d.itemIds);
    setField("intents", d.intents);
    setField("attributeFilters", d.attributeFilters);
    setField("priceMin", d.priceMin);
    setField("priceMax", d.priceMax);
    setSuggestions(res.suggestions);
    setWarnings(res.warnings);
    if (d.includeAll.length > 0) setAdvancedOpen(true);
  };

  const patchUnderstood = (patch: Partial<UnderstoodValues>) => {
    for (const [k, v] of Object.entries(patch)) setField(k as keyof WatchFormFields, v);
  };

  // Preview only for a draft the API would accept; the name is irrelevant to matching.
  const serializedValues = JSON.stringify(values);
  const previewBody = useMemo(() => {
    const v = JSON.parse(serializedValues) as Partial<WatchFormFields>;
    const parsed = watchInputSchema.safeParse({
      name: "preview",
      enabled: true,
      include: v.include ?? [],
      includeAll: v.includeAll ?? [],
      exclude: v.exclude ?? [],
      regex: v.regex || undefined,
      categoryIds: v.categoryIds ?? [],
      itemIds: v.itemIds ?? [],
      priceMin: typeof v.priceMin === "number" && !Number.isNaN(v.priceMin) ? v.priceMin : undefined,
      priceMax: typeof v.priceMax === "number" && !Number.isNaN(v.priceMax) ? v.priceMax : undefined,
      intents: v.intents ?? [],
      attributeFilters: v.attributeFilters ?? [],
      sourceIds: v.sourceIds ?? [],
    });
    return parsed.success ? (parsed.data as unknown as Record<string, unknown>) : null;
  }, [serializedValues]);
  const preview = useWatchPreview(previewBody);
  const lint = lintWatch(
    { include: (values.include ?? []) as string[], includeAll: (values.includeAll ?? []) as string[] },
    previewBody && !preview.pending && preview.data ? { total: preview.data.total } : null,
  );
  const runLint = (item: LintItem) => {
    const next = item.action?.apply({ include: (values.include ?? []) as string[], includeAll: (values.includeAll ?? []) as string[] });
    if (!next) return;
    setField("include", next.include);
    setField("includeAll", next.includeAll);
  };

  // The API's "at least one of include | includeAll | regex | categoryIds |
  // itemIds must be non-empty" refinement (packages/core watchInputSchema)
  // is attached at the schema root, i.e. issue.path === []. zodResolver maps
  // that to the object key "" (empty string), not "root" — so both keys are
  // checked here.
  const errorsRecord = errors as unknown as Record<string, { message?: string } | undefined>;
  const rootError = errorsRecord.root?.message ?? errorsRecord[""]?.message;

  const numberField = { setValueAs: (v: unknown) => (v === "" || v == null || Number.isNaN(Number(v)) ? undefined : Number(v)) };
  const understood: UnderstoodValues = {
    categoryIds: (values.categoryIds ?? []) as string[],
    itemIds: (values.itemIds ?? []) as string[],
    attributeFilters: (values.attributeFilters ?? []) as UnderstoodValues["attributeFilters"],
    priceMin: typeof values.priceMin === "number" ? values.priceMin : undefined,
    priceMax: typeof values.priceMax === "number" ? values.priceMax : undefined,
    intents: (values.intents ?? []) as UnderstoodValues["intents"],
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit((v) => onSubmit(v, ownerForSubmit ? { userId: ownerForSubmit } : undefined))}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          <Card title="Description">
            <div className="flex flex-col gap-4">
              <NlInput onParsed={applyParsed} />
              {warnings.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm text-warn">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
              <UnderstoodChips values={understood} categories={categories ?? []} items={items ?? []} onChange={patchUnderstood} />
              {suggestions ? (
                <Suggestions
                  suggestions={suggestions}
                  include={(values.include ?? []) as string[]}
                  exclude={(values.exclude ?? []) as string[]}
                  onAddInclude={(t) => setField("include", [...((values.include ?? []) as string[]), t])}
                  onAddExclude={(t) => setField("exclude", [...((values.exclude ?? []) as string[]), t])}
                />
              ) : null}
            </div>
          </Card>

          <Card title="Basics">
            <div className="flex flex-col gap-4">
              <div className="space-y-1">
                <Label htmlFor="watch-name">Name</Label>
                <Input id="watch-name" {...register("name")} />
                {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
              </div>

              <div className="flex items-center gap-2">
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => <Switch id="watch-enabled" checked={field.value} onCheckedChange={field.onChange} />}
                />
                <Label htmlFor="watch-enabled">Enabled</Label>
              </div>
              {rootError ? <p className="text-sm text-destructive">{rootError}</p> : null}
              {errorsRecord.attributeFilters?.message ? <p className="text-sm text-destructive">{errorsRecord.attributeFilters.message}</p> : null}
            </div>
          </Card>

          <Card title="Category">
            <CategoryTreePicker categories={categories ?? []} selectedIds={understood.categoryIds} onToggle={(id) => toggleInArray("categoryIds", id)} />
          </Card>

          <Card title="Filters">
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="watch-price-min">Price min (VND)</Label>
                  <Input id="watch-price-min" type="number" {...register("priceMin", numberField)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="watch-price-max">Price max (VND)</Label>
                  <Input id="watch-price-max" type="number" {...register("priceMax", numberField)} />
                  {errors.priceMax ? <p className="text-sm text-destructive">{errors.priceMax.message}</p> : null}
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Intents</legend>
                <div className="flex gap-3">
                  {INTENTS.map((intent) => (
                    <label key={intent} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={(values.intents ?? []).includes(intent)}
                        onChange={() => toggleInArray("intents", intent)}
                      />
                      {intent}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </Card>

          <Card title="Advanced">
            <div className="flex flex-col gap-4">
              <button
                type="button"
                className="self-start text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((o) => !o)}
              >
                {advancedOpen ? "Hide keywords, regex and sources" : "Keywords, regex and sources"}
              </button>
              {advancedOpen ? (
                <div className="flex flex-col gap-4">
                  <Controller
                    control={control}
                    name="include"
                    render={({ field }) => <ChipInput id="watch-include" label="Include (any)" value={field.value ?? []} onChange={field.onChange} />}
                  />
                  <Controller
                    control={control}
                    name="includeAll"
                    render={({ field }) => <ChipInput id="watch-include-all" label="Must contain all of" value={field.value ?? []} onChange={field.onChange} />}
                  />
                  <Controller
                    control={control}
                    name="exclude"
                    render={({ field }) => <ChipInput id="watch-exclude" label="Exclude" value={field.value ?? []} onChange={field.onChange} />}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="watch-regex">Regex (optional)</Label>
                    <Input id="watch-regex" {...register("regex")} placeholder="e.g. iphone\s?1[3-5]" />
                    {errors.regex ? <p className="text-sm text-destructive">{errors.regex.message}</p> : null}
                  </div>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Sources</legend>
                    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                      {(sources ?? []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">No sources available.</p>
                      ) : (
                        sources?.map((src) => (
                          <label key={src.id} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              checked={(values.sourceIds ?? []).includes(src.id)}
                              onChange={() => toggleInArray("sourceIds", src.id)}
                            />
                            {src.name}
                          </label>
                        ))
                      )}
                    </div>
                  </fieldset>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Delivery">
            {isOperator && effectiveOwner ? (
              <div className="mb-4 space-y-1">
                <OwnerSelect id="watch-owner" users={users ?? []} value={effectiveOwner} onChange={changeOwner} />
                {moving ? <p className="text-sm text-muted-foreground">Moving resets the notifier picks to the new owner's defaults</p> : null}
              </div>
            ) : null}
            <div className="mb-4">
              <NotifierPicker
                ownerId={otherOwner}
                ownerLabel={ownerLabel}
                value={(values.notifierIds ?? []) as string[]}
                onChange={(ids) => setField("notifierIds", ids)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="quiet-start">Quiet hours start</Label>
                <Input id="quiet-start" type="time" {...register("quietHours.start")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quiet-end">Quiet hours end</Label>
                <Input id="quiet-end" type="time" {...register("quietHours.end")} />
              </div>
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-[72px] lg:col-span-4 lg:self-start">
          <LivePreview idle={previewBody === null} loading={preview.pending || preview.isFetching} error={preview.isError} result={preview.pending ? undefined : preview.data} />
        </div>
      </div>

      <LintList items={lint} onAction={runLint} />

      <div
        className={cn(
          "sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0",
        )}
      >
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
