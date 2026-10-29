import type { OcrRepository } from "../features/ocr/repository.js";
import type { OAuthOptions } from "../auth/options.js";
import type { OcrWriteRepository } from "../features/ocr/write-repository.js";

/** Resources assembled at startup and released when the HTTP server shuts down. */
export interface Runtime {
  repo: OcrRepository;
  /** Present only when auth.mode is "oauth". unavailableReason makes the server fail closed. */
  oauth: OAuthOptions | undefined;
  /** Opt-in OCR writer. If enabled but unavailable, read-only tools remain operational. */
  ocrWrite: { enabled: boolean; repository?: OcrWriteRepository; unavailableReason?: string };
  /** Resolves after the original-image storage startup check; failures are logged, not rejected. */
  originalImagesChecked: Promise<void>;
  close(): void;
}
