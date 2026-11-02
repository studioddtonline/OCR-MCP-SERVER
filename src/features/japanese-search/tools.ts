import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ClientSafeError } from "../../shared/errors.js";
import { guarded, textResult } from "../../shared/tool-result.js";
import type { JapaneseSearchRepository } from "./repository.js";

export interface JapaneseSearchToolOptions {
  repository?: JapaneseSearchRepository;
  unavailableReason?: string;
  maxLimit: number;
}

export function registerJapaneseSearchTool(server: McpServer, options: JapaneseSearchToolOptions): void {
  const inputSchema = z.object({
    query: z.string().trim().min(1).max(500).describe("Japanese words or phrase. One-character queries are accepted, but results follow Vaporetto tokenization rather than arbitrary substring matching."),
    mode: z.enum(["any", "all"]).optional().describe("any: match any query token (broader recall); all: require every query token (AND). Defaults to any."),
    label: z.string().optional().describe("Optional exact source label (source_images.file_path). Use to restrict the search to one book."),
    reviewed: z.boolean().optional().describe("true matches reviewed/protected rows (any non-zero value or NULL); false matches only reviewed=0 rows."),
    limit: z.number().int().min(1).max(options.maxLimit).optional(),
    offset: z.number().int().min(0).max(100000).optional().describe("Offset in the relevance-ranked result list. Searches run one at a time in a dedicated worker; queue wait does not count against the 20-second execution deadline. Prefer small offsets."),
  });

  server.registerTool("search_ocr_japanese", {
    description: "Search an independently built Japanese full-text index using Vaporetto-pretokenized terms in an FTS5 index with BM25 ranking. Requests are queued FIFO and dispatched one at a time; the execution deadline begins only when a search starts in the worker. Unlike search_ocr, this accepts one- or two-character queries and tokenizes Japanese. mode=any broadens recall; mode=all requires every token. Returns tokenization, OCR-text snippets with matches marked, review state, rank score, and nextOffset. The index is a snapshot of the OCR database: rebuild it with `npm run japanese-search:index` after OCR text or review-state changes. This is token-based search, not arbitrary substring matching.",
    inputSchema,
  }, async ({ query, mode, label, reviewed, limit, offset }, ctx) => guarded(
    "ocr/search_ocr_japanese",
    "Japanese search failed",
    async () => {
      if (!options.repository) {
        throw new ClientSafeError("Japanese search is unavailable.", {
          cause: new Error(options.unavailableReason ?? "Japanese search index was not initialized"),
        });
      }
      return textResult(await options.repository.search({
        query,
        mode: mode ?? "any",
        label,
        reviewed,
        limit: limit ?? Math.min(20, options.maxLimit),
        offset: offset ?? 0,
      }, ctx.mcpReq.signal));
    },
  ));
}
