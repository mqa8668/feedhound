import { matchPath } from "react-router-dom";

// Order matters: `/watches/new` must win over `/watches/:id`.
export const PAGE_TITLES: ReadonlyArray<{ pattern: string; title: string }> = [
  { pattern: "/sources", title: "Sources · Feedhound" },
  { pattern: "/watches", title: "Watches · Feedhound" },
  { pattern: "/watches/new", title: "New watch · Feedhound" },
  { pattern: "/watches/:id", title: "Edit watch · Feedhound" },
  { pattern: "/matches", title: "Matches · Feedhound" },
  { pattern: "/posts/:id", title: "Post · Feedhound" },
  { pattern: "/health", title: "Health · Feedhound" },
  { pattern: "/403", title: "Forbidden · Feedhound" },
];

const NOT_FOUND_TITLE = "Not found · Feedhound";

export function pageTitle(pathname: string, unseen: number): string {
  const hit = PAGE_TITLES.find((p) => matchPath({ path: p.pattern, end: true }, pathname));
  const title = hit?.title ?? NOT_FOUND_TITLE;
  if (unseen <= 0) return title;
  return `(${unseen > 9 ? "9+" : unseen}) ${title}`;
}
