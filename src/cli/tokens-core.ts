import { parseArgs } from "node:util";
import { parseScopes } from "../auth/scopes.js";
import type { StaticTokenRecord, TokenPurpose, TokenStore } from "../auth/token-store.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `使い方: npm run token -- <コマンド> [オプション]

コマンド:
  create --name <名前> --purpose <api|login> [--scope ocr:write] [--expires-in-days <日数>]
      トークンを発行します。トークンは発行時に一度だけ表示されます。
        api   : MCP の Authorization: Bearer に使う。
                既定のスコープは ocr:read のみ。書き込み系は --scope で明示した場合だけ付与。
        login : OAuth 同意画面のログインに使う。MCP へのアクセスには使えません。
  list
      発行済みトークンの一覧 (トークン本体は表示されません)。
  revoke --name <名前>
      有効なトークンを失効させます。ローテーションは revoke のあとに同じ名前で create します。`;

function fmt(sec: number | null): string {
  return sec === null ? "-" : new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function table(rows: StaticTokenRecord[]): string[] {
  const head = ["NAME", "PURPOSE", "SCOPE", "STATUS", "CREATED", "LAST USED", "EXPIRES"];
  const body = rows.map((r) => [r.name, r.purpose, r.scopes.join(",") || "-", r.status, fmt(r.createdAt), fmt(r.lastUsedAt), fmt(r.expiresAt)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(head), ...body.map(line)];
}

/** CLI の本体。終了コードを返す (0: 成功 / 1: 失敗 / 2: 使い方の誤り)。 */
export function runTokenCli(argv: string[], store: TokenStore, io: CliIo, opts: { mcpUrl?: string } = {}): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  let values: { name?: string; purpose?: string; scope?: string[]; "expires-in-days"?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        purpose: { type: "string" },
        scope: { type: "string", multiple: true },
        "expires-in-days": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }

  try {
    if (command === "list") {
      const rows = store.list();
      io.out(rows.length === 0 ? "(トークンはありません)" : table(rows).join("\n"));
      return 0;
    }
    if (command === "revoke") {
      if (!values.name) { io.err("--name が必要です"); return 2; }
      if (!store.revoke(values.name)) { io.err(`有効なトークン "${values.name}" は見つかりません`); return 1; }
      io.out(`失効しました: ${values.name}`);
      return 0;
    }
    if (command === "create") {
      if (!values.name) { io.err("--name が必要です"); return 2; }
      if (values.purpose !== "api" && values.purpose !== "login") { io.err("--purpose は api か login を指定してください"); return 2; }
      const purpose: TokenPurpose = values.purpose;
      const days = values["expires-in-days"] === undefined ? undefined : Number(values["expires-in-days"]);
      const { token, record } = store.create({
        name: values.name,
        purpose,
        scopes: (values.scope ?? []).flatMap((s) => parseScopes(s)),
        ...(days === undefined ? {} : { expiresInDays: days }),
      });
      io.out(`作成しました: name=${record.name} purpose=${record.purpose} scope=${record.scopes.join(",") || "-"} expires=${fmt(record.expiresAt)}`);
      io.out("このトークンは今回だけ表示されます。安全な場所に保存してください:");
      io.out("");
      io.out(`  ${token}`);
      io.out("");
      if (purpose === "login") {
        io.out("使い方: 新しいクライアントを接続するとき、同意画面の「ログイン用トークン」欄に貼り付けます (許可のたびに毎回必要)。");
        io.out("このトークンは MCP へのアクセスには使えません。");
      } else {
        io.out("利用方法は README.md の「静的 API トークンの使い方 (purpose=api)」を参照してください。");
      }
      return 0;
    }
    io.err(`不明なコマンド: ${command}`);
    io.err(USAGE);
    return 2;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
