// Advisory display titles. Pure.

import { containsDigitRun, renderValue, type AttributeSchema, type Attributes } from "./attributes";

export const MAX_TITLE = 80;

function render(schema: AttributeSchema, attributes: Attributes, key: string): string | null {
  const def = schema.find((d) => d.key === key);
  const v = attributes[key];
  if (!def || v === undefined) return null;
  return renderValue(def, v);
}

function clip(title: string): string {
  if (title.length <= MAX_TITLE) return title;
  const head = title.slice(0, MAX_TITLE);
  const sep = head.lastIndexOf(" · ");
  if (sep > 0) return head.slice(0, sep);
  const sp = title.charAt(MAX_TITLE) === " " ? MAX_TITLE : head.lastIndexOf(" ");
  return (sp > 0 ? head.slice(0, sp) : head).trim();
}

/** Rule-based title: cars "<make> <model> <year> · ..."; others "<item> · <key attrs>"; null if nothing to say. */
export function ruleTitle(input: {
  itemName: string | null;
  attributes: Attributes;
  schema: AttributeSchema;
  isCar: boolean;
}): string | null {
  const { itemName, attributes, schema, isCar } = input;
  if (isCar) {
    const make = render(schema, attributes, "make");
    const model = render(schema, attributes, "model");
    if (!make && !model) return null;
    const head = [make, model, render(schema, attributes, "year")].filter((x): x is string => x !== null).join(" ");
    const extras = ["transmission", "odo_km", "fuel"]
      .map((k) => render(schema, attributes, k))
      .filter((x): x is string => x !== null)
      .slice(0, 2);
    return clip([head, ...extras].join(" · "));
  }
  if (!itemName) return null;
  const vals = schema
    .filter((d) => d.keyAttr)
    .map((d) => render(schema, attributes, d.key))
    .filter((x): x is string => x !== null);
  return clip([itemName, ...vals].join(" · "));
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
const URL_RE = /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|vn|io|me|app|xyz|info|co|ly|link)\b/i;

/** Strips control chars, turns newlines into spaces, collapses whitespace; null when markup or a URL/domain remains. */
function sanitizeTitle(raw: string): string | null {
  const t = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length === 0 || /[<>]/.test(t) || URL_RE.test(t)) return null;
  return t;
}

/** Keeps an LLM title only if it is clean text and every digit run in it appears (as a whole run) in the post text or a rendered attribute value. */
export function acceptLlmTitle(
  title: string | null | undefined,
  textFolded: string,
  attributes: Attributes,
  schema: AttributeSchema,
): string | null {
  const t = sanitizeTitle(title ?? "");
  if (t === null) return null;
  const rendered = schema
    .map((d) => render(schema, attributes, d.key))
    .filter((x): x is string => x !== null)
    .join(" ");
  const hay = `${textFolded} ${rendered.toLowerCase()}`;
  for (const run of t.match(/\d+/g) ?? []) {
    if (!containsDigitRun(hay, run)) return null;
  }
  return clip(t) || null;
}
