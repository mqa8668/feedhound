import { WATCH_TEMPLATES, type WatchTemplate } from "@/lib/watch-templates";

export interface TemplateGalleryProps {
  onPick: (t: WatchTemplate) => void;
}

/** Starting points for `/watches/new`; picking prefills the builder and saves nothing. */
export function TemplateGallery({ onPick }: TemplateGalleryProps) {
  return (
    <section aria-label="Watch templates" className="flex flex-col gap-2">
      <p className="text-sm font-medium">Start from a template</p>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {WATCH_TEMPLATES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onPick(t)}
              className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-line bg-card p-3 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-sm font-medium">{t.title}</span>
              <span className="text-fs-sm text-muted-foreground">{t.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
