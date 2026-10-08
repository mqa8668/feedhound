export type LintCode = "include_all_zero" | "no_hits_7d" | "too_broad";

export interface LintDraft {
  include: string[];
  includeAll: string[];
}

export interface LintItem {
  code: LintCode;
  message: string;
  action?: { label: string; apply: (draft: LintDraft) => LintDraft };
}

export const TOO_BROAD_PER_DAY = 200;
export const PREVIEW_DAYS = 7;

/** "Use any of": moves every `includeAll` term into `include` (deduplicated, order kept). */
export function mergeAllIntoAny(draft: LintDraft): LintDraft {
  const include = [...draft.include];
  for (const t of draft.includeAll) if (!include.includes(t)) include.push(t);
  return { include, includeAll: [] };
}

/** Warnings only: never blocks Save. `preview` is the 7-day preview total, null while unknown. */
export function lintWatch(draft: LintDraft, preview: { total: number } | null): LintItem[] {
  if (!preview) return [];
  const out: LintItem[] = [];
  const includeAllZero = draft.includeAll.length >= 2 && preview.total === 0;
  if (includeAllZero) {
    out.push({
      code: "include_all_zero",
      message: "No post contains all of these words. Did you mean to match any of them?",
      action: { label: "Use \"any\"", apply: mergeAllIntoAny },
    });
  }
  if (preview.total === 0 && !includeAllZero) {
    out.push({ code: "no_hits_7d", message: "No matches in the last 7 days. Try loosening the conditions." });
  }
  if (preview.total / PREVIEW_DAYS > TOO_BROAD_PER_DAY) {
    out.push({ code: "too_broad", message: "Conditions are too broad (over 200 posts per day). Add keywords or a price to narrow them." });
  }
  return out;
}
