import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ClientSafeError } from "../../shared/errors.js";
import { guarded, textResult } from "../../shared/tool-result.js";
import { SearchCancelledError, SearchQueryError, SearchQueryValidationError, SearchUnavailableError, SearchWorkerError, type OcrSearch } from "ocr-search";

export interface JapaneseSearchToolOptions {
  repository?: OcrSearch;
  unavailableReason?: string;
  maxLimit: number;
}

// Built once per maxLimit, not per request: the MCP SDK hands every HTTP request a fresh McpServer,
// and constructing this chained Zod schema (about 30 clones) dominated the per-request registration cost.
const inputSchemaByMaxLimit = new Map<number, ReturnType<typeof buildInputSchema>>();

function buildInputSchema(maxLimit: number) {
  return z.object({
    query: z.string().trim().min(1).max(500).describe("Japanese words or phrase. One-character queries are accepted, but results follow Vaporetto tokenization rather than arbitrary substring matching."),
    mode: z.enum(["any", "all"]).optional().describe("any: match any query token (broader recall); all: require every query token (AND). Defaults to any."),
    label: z.string().optional().describe("Optional exact source label (source_images.file_path). Use to restrict the search to one book."),
    reviewed: z.boolean().optional().describe("true matches reviewed/protected rows (any non-zero value or NULL); false matches only reviewed=0 rows."),
    limit: z.number().int().min(1).max(maxLimit).optional(),
    offset: z.number().int().min(0).max(100000).optional().describe("Offset in the relevance-ranked result list. Searches run one at a time in a dedicated worker; queue wait does not count against the 20-second execution deadline. Prefer small offsets."),
  });
}

function japaneseInputSchema(maxLimit: number): ReturnType<typeof buildInputSchema> {
  let schema = inputSchemaByMaxLimit.get(maxLimit);
  if (!schema) {
    schema = buildInputSchema(maxLimit);
    inputSchemaByMaxLimit.set(maxLimit, schema);
  }
  return schema;
}

export function registerJapaneseSearchTool(server: McpServer, options: JapaneseSearchToolOptions): void {
  const inputSchema = japaneseInputSchema(options.maxLimit);

  server.registerTool("search_ocr_japanese", {
    description: "Search the OCR-SEARCH Japanese index using Vaporetto-pretokenized terms and BM25 ranking. Requests are queued FIFO in a dedicated Worker. Unlike search_ocr, this accepts one- or two-character queries and tokenizes Japanese. mode=any broadens recall; mode=all requires every token. Returns query tokens, current source metadata and OCR snippets, review state, BM25 score, index metadata, and nextOffset. Candidate membership and ranking use the index snapshot; rebuild it with `npm run japanese-search:index` after OCR records or text change. This is token-based search, not arbitrary substring matching.",
    inputSchema,
  }, async ({ query, mode, label, reviewed, limit, offset }, ctx) => guarded(
    "ocr/search_ocr_japanese",
    "Japanese search failed",
    async () => {
      if (!options.repository || options.unavailableReason) {
        throw new ClientSafeError("Japanese search is unavailable.", {
          cause: new Error(options.unavailableReason ?? "Japanese search index was not initialized"),
        });
      }
      try {
        return textResult(await options.repository.searchJapanese({
          query,
          mode: mode ?? "any",
          label,
          reviewed,
          limit: limit ?? Math.min(20, options.maxLimit),
          offset: offset ?? 0,
        }, ctx.mcpReq.signal));
      } catch (error) {
        if (error instanceof SearchQueryValidationError || error instanceof SearchUnavailableError || error instanceof SearchCancelledError || error instanceof SearchQueryError || error instanceof SearchWorkerError) throw new ClientSafeError(error.message);
        throw error;
      }
    },
  ));
}
