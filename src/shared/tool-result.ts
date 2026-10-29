import { clientMessage, describeForLog } from "./errors.js";

/** Standard JSON text result shared by feature-specific MCP tools. */
export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Converts unexpected failures to a fixed client-safe message while retaining details in server logs. */
function failure(tag: string, error: unknown, fallback: string) {
  console.log(`[${tag}] tool execution failed:`, describeForLog(error));
  return { ...textResult({ error: clientMessage(error, fallback) }), isError: true as const };
}

export async function guarded<T>(tag: string, fallback: string, run: () => T | Promise<T>) {
  try {
    return await run();
  } catch (error) {
    return failure(tag, error, fallback);
  }
}
