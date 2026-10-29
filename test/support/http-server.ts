import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Common ephemeral-listener setup for HTTP integration tests bound to 127.0.0.1. */
export async function waitForTestServer(server: Server): Promise<{ port: number; base: string }> {
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  const { port } = address as AddressInfo;
  return { port, base: `http://127.0.0.1:${port}` };
}

export async function closeTestServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
