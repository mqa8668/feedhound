// Tokens never emitted by extractTerms (they also break n-grams).
const VI = [
  "và", "của", "có", "cho", "là", "các", "với", "được", "này", "không", "bán", "mua", "cần", "giá", "ạ", "nha", "nhé",
  "ib", "inbox", "lh", "liên", "hệ", "ở", "tại", "em", "anh", "chị", "mình", "bạn", "một", "những", "để", "thì", "mà",
];
const EN = [
  "the", "a", "an", "and", "or", "for", "of", "to", "in", "on", "is", "are", "with", "sale", "sell", "buy", "new",
  "at", "by", "it", "this", "that", "be", "from",
];

export const STOPWORDS: ReadonlySet<string> = new Set([...VI, ...EN]);
