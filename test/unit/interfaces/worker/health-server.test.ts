import { afterEach, describe, expect, it } from 'vitest';
import {
  HealthServer,
  type ReadinessChecks,
} from '../../../../src/interfaces/worker/health-server';

const healthy = (): ReadinessChecks => ({
  postgres: async () => {},
  redis: async () => {},
  workersRunning: () => true,
});

describe('HealthServer', () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(checks: ReadinessChecks = healthy()) {
    server = new HealthServer(checks);
    const port = await server.listen(0, '127.0.0.1');
    return (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  }

  it('answers /health with 200', async () => {
    const get = await start();

    const response = await get('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers /ready with 200 and the state of each dependency', async () => {
    const get = await start();

    const response = await get('/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', workers: 'ok' },
    });
  });

  it.each([
    ['postgres', { postgres: () => Promise.reject(new Error('down')) }],
    ['redis', { redis: () => Promise.reject(new Error('down')) }],
    ['workers', { workersRunning: () => false }],
  ])('answers /ready with 503 when %s fails', async (failing, override) => {
    const get = await start({ ...healthy(), ...override });

    const response = await get('/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      checks: { [failing]: 'error' },
    });
  });

  it('answers /ready with 503 while shutting down', async () => {
    const get = await start();
    server?.markShuttingDown();

    const response = await get('/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'shutting_down' });
  });

  it('answers an unknown path with 404', async () => {
    const get = await start();

    expect((await get('/metrics')).status).toBe(404);
  });
});
