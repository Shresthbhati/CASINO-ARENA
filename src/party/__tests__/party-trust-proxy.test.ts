// @vitest-environment node
/**
 * Per-player rate limits behind a reverse proxy. Without help, every request would come from the
 * proxy's address and one player's burst would lock everyone out; with TRUST_PROXY the address is the
 * last X-Forwarded-For entry (the proxy's own), and a client cannot choose it by sending the header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';

let http: RunningPartyHttp | null = null;
afterEach(async () => {
  await http?.close();
  http = null;
});

async function boot(trustProxy: boolean) {
  http = createPartyHttpServer(new PartyServer(), { createPerMinute: 1, trustProxy });
  return `http://127.0.0.1:${await http.listen(0)}`;
}
const create = (base: string, name: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/party/create`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name }) });

describe('behind a proxy', () => {
  it('off by default: the header is ignored, so everyone shares one limit (the safe direct-exposure behaviour)', async () => {
    const base = await boot(false);
    expect((await create(base, 'A', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200);
    expect((await create(base, 'B', { 'x-forwarded-for': '10.0.0.2' })).status).toBe(429);
  });

  it('on: different players behind the proxy get separate limits', async () => {
    const base = await boot(true);
    expect((await create(base, 'A', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200);
    expect((await create(base, 'B', { 'x-forwarded-for': '10.0.0.2' })).status).toBe(200);
    // The same player twice is still limited.
    expect((await create(base, 'C', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(429);
  });

  it('on: a client cannot dodge the limit by forging earlier entries in the header', async () => {
    const base = await boot(true);
    // The proxy appends the real address last; the client controls only what comes before it.
    expect((await create(base, 'A', { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' })).status).toBe(200);
    expect((await create(base, 'B', { 'x-forwarded-for': '2.2.2.2, 9.9.9.9' })).status).toBe(429);
    expect((await create(base, 'C', { 'x-forwarded-for': '3.3.3.3, 9.9.9.9' })).status).toBe(429);
  });

  it('on, but no header (a direct request): falls back to the socket address', async () => {
    const base = await boot(true);
    expect((await create(base, 'A')).status).toBe(200);
    expect((await create(base, 'B')).status).toBe(429);
  });
});
