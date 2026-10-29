import type { AuthzRequest, PageRenderer } from "./types.js";
import { OPTIONAL_SCOPES, SCOPE_LABELS, SCOPE_READ } from "../scopes.js";
import { looksLikeUrlClientId } from "../cimd.js";
import { html, page } from "./responses.js";

export function createPageRenderer(formAction: string): PageRenderer {
  return (title, body, status = 200) => page(title, body, formAction, status);
}

export function renderConsentPage(
  render: PageRenderer,
  request: AuthzRequest,
  resource: string,
  error?: string,
  status = 200,
): Response {
  const who = looksLikeUrlClientId(request.clientId)
    ? `<strong>${html(new URL(request.clientId).host)}</strong>（クライアントのメタデータ文書で確認済みのホスト）`
    : `<strong>${html(request.client.clientName)}</strong>（自己申告の名前。<strong>未検証</strong>）`;
  const optional = OPTIONAL_SCOPES.filter((scope) => request.requested.includes(scope));
  const scopeItems =
    `<li><code>${html(SCOPE_READ)}</code>: ${html(SCOPE_LABELS[SCOPE_READ] ?? SCOPE_READ)}</li>` +
    optional.map((scope) =>
      `<li><label><input type="checkbox" name="grant_scope" value="${html(scope)}"> <code>${html(scope)}</code>: ${html(SCOPE_LABELS[scope] ?? scope)}も許可する（任意）</label></li>`
    ).join("");
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${html(value)}">`;
  return render(
    "OCR MCP へのアクセス許可",
    `${error ? `<p role="alert" style="color:#b00020"><strong>${html(error)}</strong></p>` : ""}` +
      `<p>${who} が OCR データへのアクセスを求めています。</p>` +
      `<p>戻り先: <code>${html(new URL(request.redirectUri).host)}</code></p>` +
      `<p>許可される権限:</p><form method="post" action="/authorize"><ul style="list-style:none;padding-left:0">${scopeItems}</ul>` +
      hidden("client_id", request.clientId) +
      hidden("redirect_uri", request.redirectUri) +
      hidden("response_type", "code") +
      hidden("code_challenge", request.challenge) +
      hidden("code_challenge_method", "S256") +
      hidden("resource", resource) +
      hidden("scope", request.requested.join(" ")) +
      hidden("state", request.state) +
      `<label>ログイン用トークン<br><input name="login_token" type="password" autocomplete="current-password" required style="width:100%;padding:.6rem"></label>` +
      `<p style="font-size:.9em;color:#555">サーバーで <code>npm run token -- create --purpose login --name owner</code> を実行して発行したトークンを入力してください。許可のたびに毎回入力が必要です。</p>` +
      `<p><button name="decision" value="approve">許可する</button> <button name="decision" value="deny" formnovalidate>拒否する</button></p></form>`,
    status,
  );
}
