import { useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { watchDraftSchema } from "@feedhound/core/listing";
import { WatchForm, type WatchFormValues } from "@/components/WatchForm";
import { PageHeader } from "@/components/layout/PageHeader";
import { TemplateGallery } from "@/components/watches/TemplateGallery";
import { useCategories, useCreateWatch, useUpdateWatch, useWatch } from "@/api/queries";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/api/client";
import type { WatchDto } from "@/api/types";
import type { WatchTemplate } from "@/lib/watch-templates";

export default function WatchEdit() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === "new";
  const { data: watch, isLoading, isError } = useWatch(id);
  const { data: categories } = useCategories();
  const createWatch = useCreateWatch();
  const updateWatch = useUpdateWatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const ownerParam = searchParams.get("owner") ?? undefined;
  const { toast } = useToast();
  const [template, setTemplate] = useState<{ n: number; values: Partial<WatchDto> } | null>(null);
  // "Create similar watch" hands over a draft in router state; invalid drafts are ignored.
  const parsedDraft = isNew ? watchDraftSchema.safeParse((location.state as { draft?: unknown } | null)?.draft) : undefined;
  const draft = parsedDraft?.success ? parsedDraft.data : undefined;

  if (!isNew && isLoading) return <p className="text-sm text-muted-foreground">Loading watch…</p>;
  if (!isNew && isError) return <p className="text-sm text-muted-foreground">Watch not found.</p>;

  const onSubmit = async (values: WatchFormValues, owner?: { userId: string }) => {
    try {
      if (isNew) {
        await createWatch.mutateAsync({ ...values, ...owner });
      } else if (id) {
        await updateWatch.mutateAsync({ id, ...values, ...owner });
      }
      toast({ title: "Watch saved", variant: "success" });
      const back = owner?.userId ?? ownerParam;
      navigate(back ? `/watches?owner=${back}` : "/watches");
    } catch (err) {
      toast({
        title: "Failed to save watch",
        description: err instanceof ApiError ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  // A template prefills the builder only; a slug missing from /api/categories is skipped.
  const pickTemplate = (t: WatchTemplate) => {
    const cat = t.categorySlug ? categories?.find((c) => c.slug === t.categorySlug) : undefined;
    setTemplate({
      n: (template?.n ?? 0) + 1,
      values: {
        name: t.name,
        include: t.include,
        categoryIds: cat ? [cat.id] : [],
        attributeFilters: cat ? t.attributeFilters : [],
        intents: t.intents,
        priceMax: t.priceMax ?? null,
      },
    });
  };

  const initial: Partial<WatchDto> | undefined = template
    ? template.values
    : draft
      ? {
          name: draft.name,
          include: draft.include,
          categoryIds: draft.categoryIds,
          attributeFilters: draft.attributeFilters,
          priceMin: draft.priceMin ?? null,
          priceMax: draft.priceMax ?? null,
          intents: draft.intents,
        }
      : watch;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={isNew ? "New watch" : `Edit ${watch?.name ?? ""}`} />
      {isNew && !draft && !template ? <TemplateGallery onPick={pickTemplate} /> : null}
      <WatchForm
        key={template ? `t${template.n}` : (watch?.id ?? "new")}
        defaultValues={initial}
        onSubmit={onSubmit}
        initialOwnerId={isNew ? ownerParam : undefined}
        onCancel={() => navigate("/watches")}
        submitting={createWatch.isPending || updateWatch.isPending}
      />
    </div>
  );
}
