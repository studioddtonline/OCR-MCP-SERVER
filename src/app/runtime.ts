import type { OcrRepository } from "../features/ocr/repository.js";
import type { OcrSearch } from "ocr-search";
import type { OAuthOptions } from "../auth/options.js";
import type { OcrWriteRepository } from "../features/ocr/write-repository.js";
import type { OriginalImageRepository } from "../features/original-images/repository.js";

/** Resources assembled at startup and released when the HTTP server shuts down. */
export interface Runtime {
  repo: OcrRepository;
  /** Shared search engine. It borrows the OCR DB; Runtime owns and closes that DB. */
  search: { repository?: OcrSearch; unavailableReason?: string; japaneseUnavailableReason?: string };
  oauth: OAuthOptions | undefined;
  ocrWrite: { enabled: boolean; repository?: OcrWriteRepository; unavailableReason?: string };
  originalImages: OriginalImageRepository;
  originalImagesChecked: Promise<void>;
  close(): void;
}
