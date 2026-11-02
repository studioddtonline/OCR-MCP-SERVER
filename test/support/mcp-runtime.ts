import type { OcrRepository } from "../../src/features/ocr/repository.js";
import { OriginalImageRepository } from "../../src/features/original-images/repository.js";
import type { McpRuntimeDependencies } from "../../src/mcp/dependencies.js";

/** Build a small Runtime-shaped dependency object for HTTP/MCP integration tests. */
export function createTestMcpRuntime(
  repo: OcrRepository,
  options: {
    ocrWrite?: McpRuntimeDependencies["ocrWrite"];
    japaneseSearch?: McpRuntimeDependencies["japaneseSearch"];
  } = {},
): McpRuntimeDependencies {
  return {
    repo,
    ocrWrite: options.ocrWrite ?? {},
    japaneseSearch: options.japaneseSearch ?? {},
    originalImages: new OriginalImageRepository(undefined),
  };
}
