export type ReviewedSqlColumn = "si.reviewed" | "d.reviewed" | "reviewed";

export function isReviewedFlag(value: number | null | undefined): boolean;
export function reviewedSqlPredicate(column: ReviewedSqlColumn, reviewed: boolean): string;
