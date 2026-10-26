import type { Server } from 'node:http';

/**
 * Stops accepting connections and waits for in-flight requests to finish. Keep-alive connections
 * are closed as soon as they go idle (including ones that become idle after finishing a request);
 * anything still open after timeoutMs is closed forcibly. Resolves true if everything finished in time.
 */
export function closeHttpServer(server: Server, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const idleSweep = setInterval(() => server.closeIdleConnections(), 50);
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(idleSweep);
      clearTimeout(deadline);
      resolve(drained);
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish(false);
    }, timeoutMs);
    server.close(() => finish(true));
    server.closeIdleConnections();
  });
}
