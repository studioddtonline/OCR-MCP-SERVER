// スコープの定義。権限は「認証方式」ではなく「認証情報 (OAuth グラント / 静的トークン) に付くスコープ」で表す。
// 各ツールは必要なスコープを 1 つ宣言し、チェックは 1 か所の関門で行う。

export const SCOPE_READ = "ocr:read";
export const SCOPE_WRITE = "ocr:write";

/** サーバーが理解するスコープ。 */
export const KNOWN_SCOPES: ReadonlySet<string> = new Set([SCOPE_READ, SCOPE_WRITE]);

/** 同意画面でチェックボックスにする (ユーザーが任意に許可する) スコープ。既定はオフ。 */
export const OPTIONAL_SCOPES: readonly string[] = [SCOPE_WRITE];

/**
 * メタデータ (scopes_supported) と 401 チャレンジで広告するスコープ。
 * 書き込みツールの権限もメタデータと 401 チャレンジで広告する。
 */
export const ADVERTISED_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  [SCOPE_READ]: "OCR テキストの検索・閲覧",
  [SCOPE_WRITE]: "OCR データの書き込み・変更",
};

export function parseScopes(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
}
