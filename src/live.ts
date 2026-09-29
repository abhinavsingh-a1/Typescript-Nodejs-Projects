// Live order updates over WebSocket: ws://localhost:3000/live?apiKey=...
// Each browser only receives events of ITS OWN tenant.
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from 'pino';
import { getRuntime } from './runtime/index.js';
import { findTenantByKey } from './tenants.js';

export async function attachLive(server: Server, log: Logger): Promise<{ close(): void }> {
  const wss = new WebSocketServer({ server, path: '/live' });
  const clients = new Map<WebSocket, string>(); // socket -> tenantId

  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const apiKey = url.searchParams.get('apiKey');
      const tenant = apiKey ? await findTenantByKey(apiKey) : null;
      if (!tenant) {
        ws.close(4001, 'invalid api key');
        return;
      }
      clients.set(ws, tenant.id);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', tenantId: tenant.id }));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'live connection error');
      ws.close(1011, 'server error');
    }
  });

  try {
    await getRuntime().bus.subscribe((event) => {
      const message = JSON.stringify(event);
      for (const [ws, tenantId] of clients) {
        if (ws.readyState === WebSocket.CLOSED) clients.delete(ws); // closed during login
        else if (tenantId === event.tenantId && ws.readyState === WebSocket.OPEN) ws.send(message);
      }
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'live updates disabled');
  }

  return {
    close() {
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
    },
  };
}
