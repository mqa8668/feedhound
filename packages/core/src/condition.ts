// Pure item-condition classifier for Vietnamese marketplace text. No I/O.

export type Condition = "new" | "like_new" | "used" | "broken" | "unknown";

const NEW_PATTERNS = [/\bmới 100%\b/, /\bmoi 100%\b/, /\bnew 100%\b/, /\bnguyên seal\b/, /\bnguyen seal\b/, /\bfullbox\b/, /\bbrand new\b/, /\bmới tinh\b/, /\bmoi tinh\b/];
const LIKE_NEW_PATTERNS = [/\b9[0-9]%\b/, /\blike new\b/, /\bnhư mới\b/, /\bnhu moi\b/, /\bmới 9\d%\b/];
const BROKEN_PATTERNS = [/\bhỏng\b/, /\bhong\b/, /\blỗi\b/, /\bloi\b/, /\bbroken\b/, /\bxác\b/, /\bxac\b/, /\bcháy\b/, /\bchay\b/];
const USED_PATTERNS = [/\bđã qua sử dụng\b/, /\bda qua su dung\b/, /\bcũ\b/, /\bcu\b/, /\bused\b/, /\bsecond\s?hand\b/, /\bqua tay\b/];

/** Runs against `textNormalized`. First matching category wins, most specific first. */
export function detectCondition(textNormalized: string): Condition {
  const text = textNormalized.toLowerCase();

  if (BROKEN_PATTERNS.some((re) => re.test(text))) return "broken";
  if (NEW_PATTERNS.some((re) => re.test(text))) return "new";
  if (LIKE_NEW_PATTERNS.some((re) => re.test(text))) return "like_new";
  if (USED_PATTERNS.some((re) => re.test(text))) return "used";

  return "unknown";
}
