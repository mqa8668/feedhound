// Regex safety validator for user-supplied watch patterns.
// Untrusted regex sources must never reach a backtracking engine (JS `RegExp`)
// at match time. Both validation *and* matching run on `RE2` (re2-wasm), a
// linear-time (Thompson-NFA) engine that cannot exhibit catastrophic
// backtracking regardless of pattern shape — this closes the ReDoS surface
// that a backtracking-engine probe alone cannot: a probe only samples one
// input; a linear-time engine is safe for *every* input.
//
// We still keep static rejections (backreferences, lookaround — RE2 doesn't
// support these constructs anyway, so they'd fail to compile — plus the
// nested-quantifier and overlapping-alternation heuristics) and the timing
// probe as defense-in-depth / early rejection of pathological-looking
// patterns, but the actual ReDoS protection now comes from the engine choice,
// not the probe.
//
// Construction is routed through `compileCached` (regex-cache.ts): re2-wasm's
// wasm heap is never reclaimed (see that module's doc), so validation reuses
// the same compiled instance `compileWatch` will later reuse from the index
// reload path, and refuses to compile past a hard per-process cap instead of
// letting the wasm module abort. Compile failures never leak raw engine text
// to the caller — `compileCached` already
// returns a generic reason, logged internally at error level.
import { compileCached, type SafeRegex } from "./regex-cache";

export type { SafeRegex };

export type ValidateRegexResult = { ok: true; re: SafeRegex } | { ok: false; reason: string };

const DEFAULT_MAX_LEN = 200;
const PROBE_BUDGET_MS = 20;
/** 10 kB pathological probe: a long run of "a" followed by a char that never
 * matches, forcing a classic catastrophic-backtracking pattern to blow up
 * (kept as defense-in-depth even though RE2 is linear-time). */
const PROBE = `${"a".repeat(10_000)}!`;

const BACKREFERENCE_RE = /\\(?:[1-9]\d*|k<)/;
const LOOKAROUND_RE = /\(\?[=!]|\(\?<[=!]/;

/** Returns the length of a quantifier token in `src` starting at `idx`, or 0. */
function isQuantifierAt(src: string, idx: number): number {
  const ch = src[idx];
  if (ch === "*" || ch === "+" || ch === "?") {
    // Swallow a following "?" (lazy modifier) too.
    return src[idx + 1] === "?" ? 2 : 1;
  }
  if (ch === "{") {
    const m = /^\{\d*(?:,\d*)?\}/.exec(src.slice(idx));
    if (m) return src[idx + m[0].length] === "?" ? m[0].length + 1 : m[0].length;
  }
  return 0;
}

/**
 * Scans `src` (with character classes skipped) for a group that is itself
 * quantified (`(...)+`, `(...)*`, `(...){m,n}`, incl. lazy variants) and
 * whose content contains a quantifier anywhere inside it, e.g. `(a+)+` or
 * `(\w*)*`. This is the classic catastrophic-backtracking shape; it is a
 * heuristic (not a full regex-engine analysis), defense-in-depth alongside
 * the pathological-input timing probe below.
 */
function hasNestedQuantifier(src: string): boolean {
  interface Frame {
    hasQuantifier: boolean;
  }
  const stack: Frame[] = [{ hasQuantifier: false }];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      stack.push({ hasQuantifier: false });
      i++;
      continue;
    }
    if (ch === ")") {
      const frame = stack.pop() ?? { hasQuantifier: false };
      i++;
      const qLen = isQuantifierAt(src, i);
      if (qLen > 0 && frame.hasQuantifier) return true;
      const parent = stack[stack.length - 1];
      if (parent) parent.hasQuantifier = parent.hasQuantifier || frame.hasQuantifier;
      i += qLen;
      continue;
    }
    const qLen = isQuantifierAt(src, i);
    if (qLen > 0) {
      const frame = stack[stack.length - 1];
      if (frame) frame.hasQuantifier = true;
      i += qLen;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Finds `)`'s matching `(` position for the `(` at `openIdx`, honoring
 * escapes and character classes (`[...]`). Returns -1 if unbalanced.
 */
function findMatchingParen(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/** Splits `content` on top-level `|` (not inside nested `(...)` or `[...]`). */
function splitTopLevelAlternatives(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (content[j] === "^") j++;
      if (content[j] === "]") j++;
      while (j < content.length && content[j] !== "]") {
        if (content[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (ch === "|" && depth === 0) {
      parts.push(content.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  parts.push(content.slice(start));
  return parts;
}

/**
 * Scans `src` for a group `(...)` immediately followed by a quantifier whose
 * top-level alternatives inside the group overlap — i.e. two branches are
 * identical, e.g. `(a|a)+`, `(0|0)+`. This is the classic ambiguous-
 * alternation ReDoS shape (each repetition of the outer quantifier can match
 * via either identical branch, exploding the search space on a backtracking
 * engine); rejected up front regardless of which engine ultimately runs the
 * pattern.
 */
function hasOverlappingAlternation(src: string): boolean {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      const closeIdx = findMatchingParen(src, i);
      if (closeIdx === -1) {
        i++;
        continue;
      }
      const qLen = isQuantifierAt(src, closeIdx + 1);
      if (qLen > 0) {
        let content = src.slice(i + 1, closeIdx);
        // Strip a leading non-capturing / named-group marker: "?:", "?<name>", "?<=" etc.
        // (lookaround is already rejected separately; this only affects "?:" here.)
        content = content.replace(/^\?:/, "");
        const branches = splitTopLevelAlternatives(content);
        if (branches.length > 1 && new Set(branches).size !== branches.length) return true;
      }
      i = closeIdx + 1;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Validates a user-supplied regex `src` before it is ever compiled against
 * real post text. Rejects: source longer than `maxLen`, backreferences,
 * lookaround, nested quantifiers, overlapping alternation inside a quantified
 * group, compile errors, and patterns that exceed `PROBE_BUDGET_MS` against a
 * 10 kB pathological probe. On success returns the compiled pattern (an
 * `RE2` instance — linear-time, immune to catastrophic backtracking
 * regardless of input) with flags `iu`; matching only ever uses this
 * pre-compiled pattern, never re-compiles at request time.
 */
export function validateRegex(src: string, maxLen: number = DEFAULT_MAX_LEN): ValidateRegexResult {
  if (src.length > maxLen) return { ok: false, reason: `regex exceeds max length of ${maxLen}` };
  if (BACKREFERENCE_RE.test(src)) return { ok: false, reason: "backreferences are not allowed" };
  if (LOOKAROUND_RE.test(src)) return { ok: false, reason: "lookaround is not allowed" };
  if (hasNestedQuantifier(src)) return { ok: false, reason: "nested quantifiers are not allowed" };
  if (hasOverlappingAlternation(src)) {
    return { ok: false, reason: "overlapping alternation inside a quantified group is not allowed" };
  }

  const compiled = compileCached(src, "iu");
  if (!compiled.ok) return compiled;
  const re = compiled.re;

  // Defense-in-depth: still probe with a hard budget. RE2 is linear-time so
  // this should never trip in practice, but a breach here indicates the
  // engine itself is misbehaving (e.g. wasm cold-start) rather than the
  // pattern being adversarial, and we fail closed either way.
  const start = performance.now();
  re.test(PROBE);
  const elapsed = performance.now() - start;
  if (elapsed > PROBE_BUDGET_MS) return { ok: false, reason: "regex exceeds time budget on probe input" };

  return { ok: true, re };
}
