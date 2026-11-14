import { z } from "zod";
import {
  MAX_QUERY_CHILDREN,
  MAX_QUERY_DEPTH,
  MAX_QUERY_NODES,
  MAX_QUERY_TERM_CODE_POINTS,
  type QueryNode,
} from "ocr-search";

export {
  MAX_QUERY_CHILDREN,
  MAX_QUERY_DEPTH,
  MAX_QUERY_NODES,
  MAX_QUERY_TERM_CODE_POINTS,
  type QueryNode,
};

const QueryTermSchema = z.object({
  type: z.literal("term"),
  // Keep nested AST nodes opaque here; OCR-SEARCH performs iterative full validation.
  value: z.string().trim().min(1).max(MAX_QUERY_TERM_CODE_POINTS * 2),
});
const QueryNodeEnvelopeSchema = z.discriminatedUnion("type", [
  QueryTermSchema,
  z.object({ type: z.literal("and"), nodes: z.array(z.unknown()).min(2).max(MAX_QUERY_CHILDREN) }),
  z.object({ type: z.literal("or"), nodes: z.array(z.unknown()).min(2).max(MAX_QUERY_CHILDREN) }),
  z.object({ type: z.literal("not"), node: z.unknown() }),
]);
export const QueryNodeSchema: z.ZodType<QueryNode> = QueryNodeEnvelopeSchema as unknown as z.ZodType<QueryNode>;
const PlainSearchTextSchema = z.string().trim().min(1).max(MAX_QUERY_TERM_CODE_POINTS * 2);
export const SearchQuerySchema = z.union([PlainSearchTextSchema, QueryNodeSchema]);
