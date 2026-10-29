import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { OAuthStore } from "./oauth-store.js";
import { TOKEN_PREFIX, type TokenStore } from "./token-store.js";

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

/**
 * Authorization: Bearer の検証。
 *  - `ocrmcp_api_` で始まるトークン → 名前付き静的トークン (purpose=api のみ。login トークンは受け付けない)
 *  - それ以外 → OAuth アクセストークン (resource に束縛されたもの)
 * どちらの認証情報も、内部では同じ形 (scopes の配列) に正規化する。
 */
export function createTokenVerifier(store: OAuthStore, tokens: TokenStore, resource: string) {
  return {
    async verifyAccessToken(candidate: string): Promise<AuthInfo> {
      if (candidate.startsWith(TOKEN_PREFIX.api)) {
        const verified = tokens.verify(candidate, "api");
        if (!verified) throw invalidToken("Invalid, expired, or revoked token");
        return {
          token: candidate,
          clientId: `static:${verified.name}`,
          scopes: verified.scopes,
          // 有効期限のないトークンでも expiresAt を求める実装があるため、毎回先の時刻を入れる (検証は毎リクエスト行う)
          expiresAt: verified.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
        };
      }
      const token = store.verifyAccessToken(candidate, resource);
      if (!token) throw invalidToken("Invalid, expired, revoked, or wrong-resource access token");
      return {
        token: candidate,
        clientId: token.clientId,
        scopes: token.scope.split(/\s+/).filter(Boolean),
        expiresAt: token.expiresAt,
      };
    },
  };
}
