/**
 * Shared review-state semantics for OCR repositories and the Japanese-search worker.
 * Only reviewed=0 is writable/unreviewed. NULL and every other value are protected.
 */
const REVIEWED_COLUMNS = new Set(["si.reviewed", "d.reviewed", "reviewed"]);

export function isReviewedFlag(value) {
  return value !== 0;
}

export function reviewedSqlPredicate(column, reviewed) {
  if (!REVIEWED_COLUMNS.has(column)) {
    throw new TypeError("Unsupported reviewed SQL column expression");
  }
  return reviewed ? `${column} IS NOT 0` : `${column} = 0`;
}
