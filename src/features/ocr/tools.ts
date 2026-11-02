import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OcrRepository } from "./repository.js";
import { guarded, textResult } from "../../shared/tool-result.js";
import {
  MAX_QUERY_CHILDREN,
  MAX_QUERY_DEPTH,
  MAX_QUERY_NODES,
  MAX_QUERY_TERM_CODE_POINTS,
  SearchQuerySchema,
} from "./query.js";

export interface OcrToolOptions {
  defaultLimit: number;
  maxLimit: number;
  snippetLength: number;
}

const searchQueryDescription = `検索条件。文字列を指定すると単一語の検索です。1〜2 Unicodeコードポイントは OCR 本文への大文字小文字を区別する部分文字列検索、3文字以上は FTS5 trigram によるフレーズ検索になります。AND/OR/NOT を組み合わせる場合は構造化クエリを指定します。構造は {"type":"term","value":"語"}、{"type":"and"|"or","nodes":[条件,...]}、{"type":"not","node":条件} です。入れ子にできます。例: {"type":"or","nodes":[{"type":"and","nodes":[{"type":"term","value":"宮崎"},{"type":"term","value":"監督"}]},{"type":"and","nodes":[{"type":"term","value":"ラピュタ"},{"type":"not","node":{"type":"term","value":"劇場版"}}]}]}。各 term は1〜${MAX_QUERY_TERM_CODE_POINTS} Unicodeコードポイントです。最大${MAX_QUERY_NODES}ノード、最大${MAX_QUERY_DEPTH}階層、各AND/ORは2〜${MAX_QUERY_CHILDREN}個の子条件です。NOTだけの検索はできません。1〜2文字の term は OCR テーブル全体を走査するため、長い語の検索より遅くなる場合があります。検索語はSQL/FTS構文として解釈せず、文字列として扱います。`;

/**
 * Zod remains the runtime validator, but the public MCP schema must describe the
 * recursive query tree. A Standard Schema wrapper lets the SDK use the custom JSON
 * Schema for tools/list while still delegating tools/call validation to the shallow Zod schema.
 * The MCP SDK consumes Standard Schema's jsonSchema hook here; tools.test.ts guards the public tools/list shape.
 */
function withJsonSchema<S extends z.ZodType>(schema: S, jsonSchema: Record<string, unknown>): Pick<S, "~standard"> {
  return {
    "~standard": {
      ...schema["~standard"],
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  } as Pick<S, "~standard">;
}

function createSearchOcrJsonSchema(maxLimit: number): Record<string, unknown> {
  const queryNodeRef = { $ref: "#/$defs/QueryNode" };
  const termValue = {
    type: "string",
    minLength: 1,
    maxLength: MAX_QUERY_TERM_CODE_POINTS,
    pattern: "\\S",
    description: `1〜${MAX_QUERY_TERM_CODE_POINTS} Unicodeコードポイントの検索語。空白だけの値は不可。`,
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      query: {
        description: searchQueryDescription,
        oneOf: [
          {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_TERM_CODE_POINTS,
            pattern: "\\S",
            description: "単一の検索語。",
          },
          queryNodeRef,
        ],
      },
      label: { type: "string", description: "file_path に保存された source label と完全一致する条件。" },
      reviewed: {
        type: "boolean",
        description: "true はレビュー済み／保護対象、false は reviewed=0 の行だけに一致。",
      },
      limit: { type: "integer", minimum: 1, maximum: maxLimit },
      offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      afterId: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "次ページを続けるレコード ID。深い offset より優先。",
      },
    },
    required: ["query"],
    $defs: {
      QueryNode: {
        description: `term / and / or / not の再帰 AST。全体で最大${MAX_QUERY_NODES}ノード、最大${MAX_QUERY_DEPTH}階層。`,
        oneOf: [
          { $ref: "#/$defs/QueryTerm" },
          { $ref: "#/$defs/QueryAnd" },
          { $ref: "#/$defs/QueryOr" },
          { $ref: "#/$defs/QueryNot" },
        ],
      },
      QueryTerm: {
        type: "object",
        properties: {
          type: { const: "term" },
          value: termValue,
        },
        required: ["type", "value"],
      },
      QueryAnd: {
        type: "object",
        properties: {
          type: { const: "and" },
          nodes: { type: "array", minItems: 2, maxItems: MAX_QUERY_CHILDREN, items: queryNodeRef },
        },
        required: ["type", "nodes"],
      },
      QueryOr: {
        type: "object",
        properties: {
          type: { const: "or" },
          nodes: { type: "array", minItems: 2, maxItems: MAX_QUERY_CHILDREN, items: queryNodeRef },
        },
        required: ["type", "nodes"],
      },
      QueryNot: {
        type: "object",
        properties: {
          type: { const: "not" },
          node: queryNodeRef,
        },
        required: ["type", "node"],
      },
    },
  };
}

/** Configuration-driven input schemas owned by the OCR feature. */
export function createOcrToolSchemas(options: Pick<OcrToolOptions, "maxLimit">) {
  return {
    searchOcr: z.object({
      query: SearchQuerySchema.describe(searchQueryDescription),
      label: z.string().optional().describe("Exact source label stored in file_path."),
      reviewed: z.boolean().optional().describe("true matches reviewed/protected rows (any non-zero value or NULL); false matches only reviewed=0 rows."),
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
    description: `Search OCR text with either a plain string or a nested AND/OR/NOT query. Each term is evaluated independently: 1–2 Unicode code points use exact, case-sensitive substring matching in OCR text; terms of 3+ code points use an exact phrase-style FTS5 trigram lookup. Structured queries support arbitrary nested {type:'and'|'or', nodes:[...]} and {type:'not', node:...} expressions, with up to ${MAX_QUERY_NODES} nodes and ${MAX_QUERY_DEPTH} levels. Each term may contain at most ${MAX_QUERY_TERM_CODE_POINTS} Unicode code points, and AND/OR nodes may have at most ${MAX_QUERY_CHILDREN} children. A query must contain at least one positive term; NOT-only queries are rejected. One- and two-character terms scan the OCR table and may be slower; terms are treated as literal values, never as raw SQL or FTS5 syntax. Optional label and reviewed filters apply to the whole expression. Results are in record-ID order and include a snippet and nextAfterId; pass nextAfterId as afterId for the next page. Use get_ocr_record for full OCR text.`,
    inputSchema: withJsonSchema(schemas.searchOcr, createSearchOcrJsonSchema(options.maxLimit))
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
