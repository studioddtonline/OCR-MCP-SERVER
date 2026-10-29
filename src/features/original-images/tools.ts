import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { OriginalImageRepository } from "./repository.js";
import { guarded, textResult } from "../../shared/tool-result.js";

export interface OriginalImageToolOptions {
  rootPath?: string;
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

/** Registers only original-image tools; it does not depend on OCR database internals. */
export function registerOriginalImageTools(
  server: McpServer,
  options: OriginalImageToolOptions,
  schemas: OriginalImageToolSchemas
): void {
  const originalImages = new OriginalImageRepository(options.rootPath);
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
    description: "Return an original scanned-book image as MCP image content, using a book directory name and exact image filename.",
    inputSchema: schemas.getOriginalImage
  }, async ({ bookDirectory, fileName }) => guarded("original-images/get_original_image", fallback, async () => {
    const image = await originalImages.getImage(bookDirectory, fileName);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ bookDirectory: image.bookDirectory, fileName: image.fileName, sizeBytes: image.sizeBytes, mimeType: image.mimeType }) },
        { type: "image" as const, data: image.data, mimeType: image.mimeType }
      ]
    };
  }));
}
