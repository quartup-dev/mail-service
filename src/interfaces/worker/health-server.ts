import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReadinessChecks {
  postgres: () => Promise<void>; // lanza si PostgreSQL no responde
  redis: () => Promise<void>; // lanza si Redis no responde
  workersRunning: () => boolean;
}

type CheckState = 'ok' | 'error';

// Health del worker: solo para el orquestador, no se publica fuera del contenedor
export class HealthServer {
  private readonly server: Server;
  private shuttingDown = false;

  constructor(private readonly checks: ReadinessChecks) {
    this.server = createServer((request, response) => {
      if (request.url === '/health') return sendJson(response, 200, { status: 'ok' });
      if (request.url === '/ready') return void this.ready(response);
      sendJson(response, 404, { status: 'not_found' });
    });
  }

  // Devuelve el puerto real (útil con el puerto 0 en los tests)
  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  // Desde aquí /ready responde 503 para que el orquestador deje de contar con este proceso
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async ready(response: ServerResponse): Promise<void> {
    if (this.shuttingDown) return sendJson(response, 503, { status: 'shutting_down' });

    const [postgres, redis] = await Promise.all([
      stateOf(this.checks.postgres()),
      stateOf(this.checks.redis()),
    ]);
    const checks = { postgres, redis, workers: this.checks.workersRunning() ? 'ok' : 'error' };
    const ready = Object.values(checks).every((state) => state === 'ok');
    sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks });
  }
}

function stateOf(check: Promise<void>): Promise<CheckState> {
  return check.then(
    () => 'ok',
    () => 'error',
  );
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
