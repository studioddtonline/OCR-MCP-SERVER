import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OriginalImageRepository } from "./repository.js";
import { guarded, textResult } from "../../shared/tool-result.js";

export interface OriginalImageToolOptions {
  /** Shared Runtime-owned repository; its queue is shared by per-request MCP servers. */
  repository: OriginalImageRepository;
}

/** Input schemas owned by the original-image feature. */
export function createOriginalImageToolSchemas() {
  return {
    listOriginalBookDirectories: z.object({
      limit: z.number().int().min(1).max(1000).optional()
    }),
    listOriginalImages: z.object({
      bookDirectory: z.string().min(1).max(255),
      limit: z.number().int().min(1).max(2000).optional(),
      offset: z.number().int().min(0).max(1000000).optional()
    }),
    getOriginalImage: z.object({
      bookDirectory: z.string().min(1).max(255),
      fileName: z.string().min(1).max(255)
    })
  };
}

export type OriginalImageToolSchemas = ReturnType<typeof createOriginalImageToolSchemas>;

export function registerOriginalImageTools(
  server: McpServer,
  options: OriginalImageToolOptions,
  schemas: OriginalImageToolSchemas
): void {
  const originalImages = options.repository;
  const fallback = "Original image storage operation failed";

  server.registerTool("list_original_book_directories", {
    description: "List book directories directly under the configured original-image root. The directory names may differ from OCR source labels; match them using context.",
    inputSchema: schemas.listOriginalBookDirectories
  }, async ({ limit }) => guarded("original-images/list_original_book_directories", fallback, async () =>
    textResult(await originalImages.listBookDirectories(limit ?? 200))));

  server.registerTool("list_original_images", {
    description: "List supported image files in a named book directory. Supports limit (max 2000) and offset; continue with the returned nextOffset.",
    inputSchema: schemas.listOriginalImages
  }, async ({ bookDirectory, limit, offset }) => guarded("original-images/list_original_images", fallback, async () =>
    textResult(await originalImages.listImages(bookDirectory, limit ?? 500, offset ?? 0))));

  server.registerTool("get_original_image", {
    description: "Return an original scanned-book image as MCP image content. Reads are processed one at a time through a FIFO queue (up to 30 waiting requests); cancelled requests are removed or aborted, and the total queue-wait plus read time is limited to 3 minutes.",
    inputSchema: schemas.getOriginalImage
  }, async ({ bookDirectory, fileName }, ctx) => guarded("original-images/get_original_image", fallback, async () => {
    const image = await originalImages.getImage(bookDirectory, fileName, ctx.mcpReq.signal);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ bookDirectory: image.bookDirectory, fileName: image.fileName, sizeBytes: image.sizeBytes, mimeType: image.mimeType }) },
        { type: "image" as const, data: image.data, mimeType: image.mimeType },
      ]
    };
  }));
}
