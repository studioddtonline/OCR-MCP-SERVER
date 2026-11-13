import type { OcrRepository } from "../../src/features/ocr/repository.js";
import type { OcrSearch } from "ocr-search";
import { OriginalImageRepository } from "../../src/features/original-images/repository.js";
import type { McpRuntimeDependencies } from "../../src/mcp/dependencies.js";

/** Build a small Runtime-shaped dependency object for HTTP/MCP integration tests. */
export function createTestMcpRuntime(
  repo: OcrRepository,
  options: {
    ocrWrite?: McpRuntimeDependencies["ocrWrite"];
    search?: McpRuntimeDependencies["search"];
    /** Compatibility helper for tests that model an unavailable Japanese index. */
    japaneseSearch?: { unavailableReason?: string };
  } = {},
): McpRuntimeDependencies {
  const legacySearch = (repo as unknown as { search?: (request: unknown) => unknown }).search;
  const search = options.search ?? (legacySearch
    ? {
        repository: {
          search: async (request: unknown) => legacySearch(request),
          searchJapanese: async () => { throw new Error("Japanese search mock is unavailable"); },
          close: () => undefined,
        } as unknown as OcrSearch,
      }
    : {});
  return {
    repo,
    search: {
      ...search,
      japaneseUnavailableReason: search.japaneseUnavailableReason ?? options.japaneseSearch?.unavailableReason,
    },
    ocrWrite: options.ocrWrite ?? {},
    originalImages: new OriginalImageRepository(undefined),
  };
}
