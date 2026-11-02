import { z } from "zod";

/** Maximum complexity accepted for a single structured search expression. */
export const MAX_QUERY_DEPTH = 8;
export const MAX_QUERY_NODES = 32;
export const MAX_QUERY_CHILDREN = 16;
export const MAX_QUERY_TERM_CODE_POINTS = 500;

export type QueryNode =
  | { type: "term"; value: string }
  | { type: "and"; nodes: QueryNode[] }
  | { type: "or"; nodes: QueryNode[] }
  | { type: "not"; node: QueryNode };

const QueryTermSchema = z.object({
  type: z.literal("term"),
  // This is only a shallow schema. Nested children are deliberately opaque here so
  // untrusted deeply nested input cannot exhaust the JS call stack inside Zod.
  value: z.string().trim().min(1).max(MAX_QUERY_TERM_CODE_POINTS * 2),
});

const QueryNodeEnvelopeSchema = z.discriminatedUnion("type", [
  QueryTermSchema,
  z.object({ type: z.literal("and"), nodes: z.array(z.unknown()).min(2).max(MAX_QUERY_CHILDREN) }),
  z.object({ type: z.literal("or"), nodes: z.array(z.unknown()).min(2).max(MAX_QUERY_CHILDREN) }),
  z.object({ type: z.literal("not"), node: z.unknown() }),
]);

/**
 * Shallow runtime envelope schema. The MCP tool advertises the recursive AST separately
 * as JSON Schema; child values are validated iteratively by parseSearchQuery().
 */
export const QueryNodeSchema: z.ZodType<QueryNode> = QueryNodeEnvelopeSchema as unknown as z.ZodType<QueryNode>;
const PlainSearchTextSchema = z.string().trim().min(1).max(MAX_QUERY_TERM_CODE_POINTS * 2);
export const SearchQuerySchema = z.union([PlainSearchTextSchema, QueryNodeSchema]);

export class SearchQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryValidationError";
  }
}

function codePointCountExceeds(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

/**
 * Parse and validate a query without recursion. The MCP/Zod boundary validates only
 * the root node; this iterative parser enforces limits before any recursive compiler
 * or term collector sees the AST.
 */
export function parseSearchQuery(input: unknown): QueryNode {
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) throw new SearchQueryValidationError("Search query must not be empty.");
    if (codePointCountExceeds(value, MAX_QUERY_TERM_CODE_POINTS)) {
      throw new SearchQueryValidationError(`A search term must contain at most ${MAX_QUERY_TERM_CODE_POINTS} Unicode code points.`);
    }
    return { type: "term", value };
  }

  type VisitFrame = { kind: "visit"; input: unknown; depth: number; assign: (node: QueryNode) => void };
  type FinishFrame = { kind: "finish"; finish: () => void };
  const stack: Array<VisitFrame | FinishFrame> = [];
  let root: QueryNode | undefined;
  let nodeCount = 0;
  const seen = new WeakSet<object>();
  stack.push({ kind: "visit", input, depth: 1, assign: (node) => { root = node; } });

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "finish") {
      frame.finish();
      continue;
    }

    if (frame.depth > MAX_QUERY_DEPTH) {
      throw new SearchQueryValidationError(`A structured search may be nested at most ${MAX_QUERY_DEPTH} levels deep.`);
    }
    nodeCount += 1;
    if (nodeCount > MAX_QUERY_NODES) {
      throw new SearchQueryValidationError(`A structured search may contain at most ${MAX_QUERY_NODES} nodes.`);
    }

    const raw = frame.input;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SearchQueryValidationError("Each structured search node must be an object.");
    }
    if (seen.has(raw)) {
      throw new SearchQueryValidationError("A structured search must not contain cyclic or shared node objects.");
    }
    seen.add(raw);
    const object = raw as Record<string, unknown>;

    if (object.type === "term") {
      if (typeof object.value !== "string") {
        throw new SearchQueryValidationError("A term node requires a string value.");
      }
      const value = object.value.trim();
      if (!value) throw new SearchQueryValidationError("Search terms must not be empty.");
      if (codePointCountExceeds(value, MAX_QUERY_TERM_CODE_POINTS)) {
        throw new SearchQueryValidationError(`A search term must contain at most ${MAX_QUERY_TERM_CODE_POINTS} Unicode code points.`);
      }
      frame.assign({ type: "term", value });
      continue;
    }

    if (object.type === "not") {
      if (!("node" in object)) throw new SearchQueryValidationError("A NOT node requires a node property.");
      let child: QueryNode | undefined;
      stack.push({ kind: "finish", finish: () => {
        if (!child) throw new SearchQueryValidationError("A NOT node requires a child condition.");
        frame.assign({ type: "not", node: child });
      } });
      stack.push({ kind: "visit", input: object.node, depth: frame.depth + 1, assign: (node) => { child = node; } });
      continue;
    }

    if (object.type === "and" || object.type === "or") {
      if (!Array.isArray(object.nodes) || object.nodes.length < 2 || object.nodes.length > MAX_QUERY_CHILDREN) {
        throw new SearchQueryValidationError(`An ${String(object.type).toUpperCase()} node must contain 2 to ${MAX_QUERY_CHILDREN} child conditions.`);
      }
      const children = new Array<QueryNode>(object.nodes.length);
      stack.push({ kind: "finish", finish: () => {
        frame.assign({ type: object.type as "and" | "or", nodes: children });
      } });
      for (let index = object.nodes.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "visit", input: object.nodes[index], depth: frame.depth + 1, assign: (node) => { children[index] = node; } });
      }
      continue;
    }

    throw new SearchQueryValidationError("A structured search node type must be term, and, or, or not.");
  }

  if (!root) throw new SearchQueryValidationError("A search query is required.");
  if (extractPositiveTerms(root).length === 0) {
    throw new SearchQueryValidationError("A search must contain at least one positive term; NOT-only searches are not allowed.");
  }
  return root;
}

/** Collect terms under an even number of NOT nodes for best-effort result snippets. */
export function extractPositiveTerms(node: QueryNode, negated = false): string[] {
  switch (node.type) {
    case "term":
      return negated ? [] : [node.value];
    case "and":
    case "or":
      return node.nodes.flatMap((child) => extractPositiveTerms(child, negated));
    case "not":
      return extractPositiveTerms(node.node, !negated);
  }
}

export interface CompiledQuery {
  /** SQL predicate against source_images aliased as si. */
  sql: string;
  /** Bound values in SQL placeholder order. */
  params: Array<string | number>;
}

/**
 * Compile an AST into parameterized SQLite boolean expressions.
 * Terms of 1–2 Unicode code points use exact, case-sensitive instr() substring matching.
 * Longer terms use an FTS5 trigram phrase subquery. Boolean operators never enter FTS syntax.
 */
export function compileQuery(node: QueryNode): CompiledQuery {
  switch (node.type) {
    case "term":
      return compileTerm(node.value);
    case "and":
    case "or": {
      const children = node.nodes.map(compileQuery);
      const operator = node.type === "and" ? "AND" : "OR";
      return {
        sql: `(${children.map((child) => `(${child.sql})`).join(` ${operator} `)})`,
        params: children.flatMap((child) => child.params),
      };
    }
    case "not": {
      const child = compileQuery(node.node);
      return { sql: `(NOT (${child.sql}))`, params: child.params };
    }
  }
}

function compileTerm(value: string): CompiledQuery {
  if (!codePointCountExceeds(value, 2)) {
    return {
      sql: "instr(COALESCE(si.ocr_text, ''), ?) > 0",
      params: [value],
    };
  }

  const ftsPhrase = `"${value.replaceAll('"', '""')}"`;
  return {
    sql: "si.id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)",
    params: [ftsPhrase],
  };
}
