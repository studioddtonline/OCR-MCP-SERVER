import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describeForLog } from "../../shared/errors.js";
import { textResult } from "../../shared/tool-result.js";
import { OcrWriteError, type OcrWriteRepository } from "./write-repository.js";
import { OcrWriteRateLimiter } from "./write-rate-limit.js";

export interface OcrWriteToolsOptions {
  requiredScope?: string;
  repository?: OcrWriteRepository;
  unavailableReason?: string;
  rateLimiter?: OcrWriteRateLimiter;
  log?: (...args: unknown[]) => void;
}

export const updateOcrTextSchema = z.object({
  id: z.number().int().positive().describe("source_images.id"),
  newText: z.string().describe("Complete replacement OCR text; this replaces the full body, not an excerpt.")
});

function errorResult(code: string, error: string, extra: Record<string, unknown> = {}) {
  return { ...textResult({ code, error, ...extra }), isError: true as const };
}

/** Write tool: authorization and operational controls live at the tool boundary. */
export function registerOcrWriteTool(server: McpServer, options: OcrWriteToolsOptions): void {
  const limiter = options.rateLimiter ?? new OcrWriteRateLimiter();
  const log = options.log ?? console.log;
  const requiredScope = options.requiredScope ?? "ocr:write";

  server.registerTool("update_ocr_text", {
    description: "Replace the complete OCR text for an unreviewed source_images record. Requires ocr:write. Only rows with reviewed = 0 are writable; NULL and all non-zero values are protected.",
    inputSchema: updateOcrTextSchema
  }, async ({ id, newText }, extra) => {
    const authInfo = extra?.http?.authInfo;
    if (!authInfo?.scopes?.includes(requiredScope)) {
      if (limiter.shouldLog("insufficient_scope")) log(`[ocr/write] update rejected: authenticated caller lacks ${requiredScope} scope`);
      return errorResult("insufficient_scope", `This tool requires the ${requiredScope} scope.`);
    }

    if (!options.repository) {
      return errorResult("write_unavailable", "OCR writing is unavailable on this server instance.");
    }

    const rate = limiter.consume(authInfo.clientId || "authenticated-client");
    if (!rate.allowed) {
      const key = `rate-limit:${rate.rejectedBy}`;
      if (limiter.shouldLog(key)) {
        log(`[ocr/write] ${rate.rejectedBy === "server" ? "server-wide" : "per-client"} write rate limit reached; further matching events are suppressed for 60 seconds`);
      }
      return errorResult("rate_limited", "The OCR write rate limit was reached; retry after the indicated delay.", {
        retryAfterSeconds: rate.retryAfterSeconds
      });
    }

    try {
      return textResult(options.repository.writeText(id, newText));
    } catch (error) {
      if (error instanceof OcrWriteError) {
        if (error.code === "reviewed_record_protected" && limiter.shouldLog("reviewed-protected")) {
          log("[ocr/write] a write to a reviewed record was rejected; repeated events are suppressed for 60 seconds");
        }
        if (error.code === "database_busy" && limiter.shouldLog("database-busy")) {
          log("[ocr/write] SQLite was busy; database_busy responses are emitted and repeated log entries are suppressed for 60 seconds");
        }
        return errorResult(error.code, error.message);
      }
      log("[ocr/update_ocr_text] write failed:", describeForLog(error));
      return errorResult("write_failed", "The OCR write failed; the OCR text and history were rolled back when possible.");
    }
  });
}
