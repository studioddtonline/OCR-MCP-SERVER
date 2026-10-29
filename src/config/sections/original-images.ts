import { z } from "zod";

export const OriginalImagesConfigSchema = z.object({
  // Root directory directly containing one directory per book. Storage failures degrade this feature only.
  rootPath: z.string().min(1)
}).optional();
