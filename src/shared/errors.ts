// MCP クライアント (= サーバーの外側) に返してよいエラーメッセージの扱い。
//
// 方針: 例外のメッセージをそのままクライアントへ返さない。Node / SQLite のエラーには
// `ENOENT: ... realpath '/mnt/...'` のようにサーバーのローカルパスが含まれるため。
//   - ClientSafeError : メッセージをクライアントに見せてよい (入力の誤り、固定文言の障害通知など)。
//   - それ以外の例外   : サーバーログにだけ詳細を出し、クライアントには呼び出し側の汎用文言を返す。
// つまり「安全であることを明示した例外だけを通す」許可リスト方式で、新しい例外が増えても漏れない。

export class ClientSafeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientSafeError";
  }
}

/** ログ用: message に加えて cause の連鎖も含める (ローカルパスを含む元の原因はここにだけ出す)。 */
export function describeForLog(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
}

/** クライアントに返すメッセージ。ClientSafeError 以外は汎用文言に置き換える。 */
export function clientMessage(error: unknown, fallback: string): string {
  return error instanceof ClientSafeError ? error.message : fallback;
}

export function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

export function isNotFoundError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}
