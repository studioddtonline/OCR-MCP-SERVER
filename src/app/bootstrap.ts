import type { AppConfig } from "../config/types.js";
import { openReadOnlyDatabase } from "../features/ocr/sqlite.js";
import { OcrRepository } from "../features/ocr/repository.js";
import { OcrWriteRepository, OCR_WRITE_BUSY_TIMEOUT_MS } from "../features/ocr/write-repository.js";
import { JapaneseSearchRepository } from "../features/japanese-search/repository.js";
import { OriginalImageRepository } from "../features/original-images/repository.js";
import { OAuthStore } from "../auth/oauth-store.js";
import { TokenStore } from "../auth/token-store.js";
import type { OAuthOptions } from "../auth/options.js";
import type { Runtime } from "./runtime.js";
import { describeForLog } from "../shared/errors.js";

// 起動時の配線 (どのストアを開き、開けなかったときにどう劣化させるか) をここに集約する。
// index.ts から切り出してあるのは、この判断をユニットテストで検証できるようにするため。
//
// 方針 (変更しない):
//   - 設定の構造ミス (loadConfig が投げる例外) はここへ来る前に起動を止める。
//   - 環境の問題 (DB やストレージを開けない) ではサーバーを止めず、該当機能を劣化させる。
//   - 認証 DB が使えないときは MCP を 503 で閉じる (無認証公開にはしない)。
//   - 起動時に開けなかった DB は、再起動するまで復旧を試みない。

export const MINIMUM_SUPPORTED_NODE_VERSION = "22.16.0";

export interface BootstrapOptions {
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
  /** Override the OCR DB opener for startup-path tests. */
  openDatabase?: typeof openReadOnlyDatabase;
  /** Override the writable OCR repository opener for degraded-start tests. */
  openWriteRepository?: typeof OcrWriteRepository.open;
  /** Override the Japanese index opener for startup-path tests. */
  openJapaneseSearchRepository?: typeof JapaneseSearchRepository.open;
}

/** Make the common missing-FTS5 failure actionable without changing degraded-start behavior. */
export function describeOcrDatabaseFailure(error: unknown): string {
  const reason = describeForLog(error);
  if (/no such module:\s*fts5/i.test(reason)) {
    return `SQLite FTS5 is unavailable in this runtime (Node.js ${process.versions.node}). ` +
      `This project requires Node.js >=${MINIMUM_SUPPORTED_NODE_VERSION} with SQLite FTS5 support. Original error: ${reason}`;
  }
  return reason;
}

function requiredPath(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} is not configured`);
  return value;
}

export function bootstrap(config: AppConfig, options: BootstrapOptions = {}): Runtime {
  if (config.ocrWrite?.enabled && config.auth.mode !== "oauth") {
    throw new Error('ocrWrite.enabled requires auth.mode to be "oauth"');
  }
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const openDatabase = options.openDatabase ?? openReadOnlyDatabase;

  let db: ReturnType<typeof openReadOnlyDatabase> | undefined;
  let repo: OcrRepository;
  try {
    db = openDatabase({ path: config.database.path, busyTimeoutMs: config.database.busyTimeoutMs });
    repo = new OcrRepository(db);
    log("[startup] OCR database opened and schema validated");
  } catch (error) {
    const reason = describeOcrDatabaseFailure(error);
    // ドライバのエラーはパスを含まない場合がある (例: "disk I/O error") ため、失敗した設定パスを運用者向けログに明記する。
    log(`[startup] OCR database unavailable (database.path=${config.database.path}); server will start and OCR tools will return runtime errors:`, reason);
    repo = new OcrRepository(undefined, reason);
  }

  const ocrWrite: Runtime["ocrWrite"] = { enabled: config.ocrWrite?.enabled ?? false };
  if (ocrWrite.enabled) {
    const openWriteRepository = options.openWriteRepository ?? OcrWriteRepository.open;
    try {
      ocrWrite.repository = openWriteRepository(config.database.path, {
        log,
        busyTimeoutMs: OCR_WRITE_BUSY_TIMEOUT_MS,
      });
      log("[startup] OCR write repository opened; reviewed records remain protected and edit history is enabled");
    } catch (error) {
      ocrWrite.unavailableReason = describeForLog(error);
      log(`[startup] OCR write repository unavailable (database.path=${config.database.path}); read-only tools will remain available and update_ocr_text will return write_unavailable:`, ocrWrite.unavailableReason);
    }
  }

  const japaneseSearch: Runtime["japaneseSearch"] = { enabled: config.japaneseSearch?.enabled ?? false };
  if (japaneseSearch.enabled) {
    const openJapaneseSearchRepository = options.openJapaneseSearchRepository ?? JapaneseSearchRepository.open;
    try {
      const settings = config.japaneseSearch;
      japaneseSearch.repository = openJapaneseSearchRepository({
        indexPath: requiredPath(settings?.indexPath, "japaneseSearch.indexPath"),
        extensionPath: requiredPath(settings?.extensionPath, "japaneseSearch.extensionPath"),
        busyTimeoutMs: settings?.busyTimeoutMs ?? 500,
        maxLimit: settings?.maxLimit ?? 20,
        log,
      });
      log("[startup] Japanese sqlite-vaporetto worker launched; index validation is running asynchronously");
    } catch (error) {
      japaneseSearch.unavailableReason = describeForLog(error);
      log(`[startup] Japanese search unavailable (japaneseSearch.indexPath=${config.japaneseSearch?.indexPath ?? "not configured"}); the Japanese search tool will return a fixed error:`, japaneseSearch.unavailableReason);
    }
  }

  let oauth: OAuthOptions | undefined;
  let oauthStore: OAuthStore | undefined;
  let tokenStore: TokenStore | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  if (config.auth.mode === "oauth") {
    if (config.legacyBearerTokenPresent) {
      logError(
        "MCP_BEARER_TOKEN is no longer used and is ignored. Issue tokens with: npm run token -- create --purpose login|api --name <n>",
      );
    }
    let oauthError: string | undefined;
    try {
      oauthStore = new OAuthStore(requiredPath(config.oauth?.databasePath, "oauth.databasePath"));
      log("[startup] OAuth database opened and schema initialized");
    } catch (error) {
      oauthError = `OAuth database: ${describeForLog(error)}`;
      log(`[startup] OAuth database unavailable (oauth.databasePath=${config.oauth?.databasePath ?? "not configured"}); OAuth-dependent requests will return runtime errors:`, oauthError);
    }
    try {
      tokenStore = new TokenStore(requiredPath(config.staticTokens?.databasePath, "staticTokens.databasePath"));
      log("[startup] static-token database opened and schema initialized");
    } catch (error) {
      const reason = `static-token database: ${describeForLog(error)}`;
      oauthError = oauthError ? `${oauthError}; ${reason}` : reason;
      log(`[startup] static-token database unavailable (staticTokens.databasePath=${config.staticTokens?.databasePath ?? "not configured"}); OAuth-dependent requests will return runtime errors:`, reason);
    }
    if (oauthStore && tokenStore && !oauthError) {
      try {
        oauthStore.cleanupExpired();
        cleanupTimer = setInterval(() => {
          try { oauthStore?.cleanupExpired(); }
          catch (error) { logError("[oauth] database cleanup failed", describeForLog(error)); }
        }, 6 * 60 * 60 * 1000);
        cleanupTimer.unref();
      } catch (error) {
        oauthError = `OAuth database initialization: ${describeForLog(error)}`;
        log("[startup] OAuth database initialization failed; OAuth-dependent requests will return runtime errors:", oauthError);
      }
    }
    oauth = oauthError || !oauthStore || !tokenStore
      ? { status: "unavailable", unavailableReason: oauthError ?? "OAuth databases are unavailable" }
      : { status: "ready", store: oauthStore, tokens: tokenStore };
  }

  const originalImages = new OriginalImageRepository(config.originalImages?.rootPath);
  const originalImagesChecked = originalImages.checkAtStartup().then(() => {
    log(`[startup] original image storage accessible: ${config.originalImages?.rootPath}`);
  }).catch((error) => {
    log(`[startup] original image storage unavailable (originalImages.rootPath=${config.originalImages?.rootPath ?? "not configured"}); server will start and image tools will return runtime errors:`, describeForLog(error));
  });

  return {
    repo,
    oauth,
    ocrWrite,
    japaneseSearch,
    originalImages,
    originalImagesChecked,
    close() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      for (const closeStore of [() => originalImages.close(), () => db?.close(), () => ocrWrite.repository?.close(), () => japaneseSearch.repository?.close(), () => oauthStore?.close(), () => tokenStore?.close()]) {
        try { closeStore(); } catch (error) { logError("[shutdown] failed to close a database:", describeForLog(error)); }
      }
    },
  };
}
