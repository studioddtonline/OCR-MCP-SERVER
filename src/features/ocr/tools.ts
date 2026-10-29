import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OcrRepository } from "./repository.js";
import { guarded, textResult } from "../../shared/tool-result.js";

export interface OcrToolOptions {
  defaultLimit: number;
  maxLimit: number;
  snippetLength: number;
}

/** Configuration-driven input schemas owned by the OCR feature. */
export function createOcrToolSchemas(options: Pick<OcrToolOptions, "maxLimit">) {
  return {
    searchOcr: z.object({
      query: z.string().trim().min(3).max(500),
      label: z.string().optional().describe("Exact source label stored in file_path."),
      reviewed: z.boolean().optional().describe("true for human-reviewed OCR; false for not yet reviewed."),
      limit: z.number().int().min(1).max(options.maxLimit).optional(),
      offset: z.number().int().min(0).max(1000000).optional(),
      afterId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("Continue after this record ID; prefer this cursor over a deep offset.")
    }),
    getOcrRecord: z.object({
      id: z.number().int().positive(),
      maxTextLength: z.number().int().min(100).max(20000).optional()
    }),
    listSourceLabels: z.object({
      limit: z.number().int().min(1).max(500).optional()
    }),
    getOcrStats: z.object({})
  };
}

export type OcrToolSchemas = ReturnType<typeof createOcrToolSchemas>;

/** Registers only OCR-related tools; HTTP/authentication details stay outside the feature. */
export function registerOcrTools(
  server: McpServer,
  repo: OcrRepository,
  options: OcrToolOptions,
  schemas: OcrToolSchemas
): void {
  const fallback = "OCR database operation failed";

  server.registerTool("search_ocr", {
    description: "Search OCR text using an exact phrase. Returns metadata, a short snippet, and nextAfterId. For follow-up pages, pass nextAfterId as afterId rather than using a deep offset; use get_ocr_record for full text.",
    inputSchema: schemas.searchOcr
  }, async ({ query, label, reviewed, limit, offset, afterId }) => guarded("ocr/search_ocr", fallback, () =>
    textResult(repo.search({
      query, label, reviewed,
      limit: limit ?? options.defaultLimit,
      offset: offset ?? 0,
      afterId,
      snippetLength: options.snippetLength
    }))));

  server.registerTool("get_ocr_record", {
    description: "Get OCR metadata and text for a single source_images record by ID.",
    inputSchema: schemas.getOcrRecord
  }, async ({ id, maxTextLength }) => guarded("ocr/get_ocr_record", fallback, () => {
    const record = repo.getById(id, maxTextLength ?? 8000);
    if (!record) return { ...textResult({ error: "Record not found", id }), isError: true as const };
    return textResult(record);
  }));

  server.registerTool("list_source_labels", {
    description: "List up to the requested number of distinct non-empty source labels and record counts (default 100).",
    inputSchema: schemas.listSourceLabels
  }, async ({ limit }) => guarded("ocr/list_source_labels", fallback, () =>
    textResult(repo.listLabels(limit ?? 100))));

  server.registerTool("get_ocr_stats", {
    description: "Return counts of OCR records, human-reviewed records, unreviewed records, and labels.",
    inputSchema: schemas.getOcrStats
  }, async () => guarded("ocr/get_ocr_stats", fallback, () => textResult(repo.getStats())));
}
