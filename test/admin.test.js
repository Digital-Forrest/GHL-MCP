/**
 * Integration tests for the admin UI and account REST API.
 *
 * Uses SELF.fetch() to exercise the full Worker, and env.DB from
 * cloudflare:test to set up / tear down the accounts table between tests.
 *
 * Requires .dev.vars to contain:
 *   MCP_AUTH_TOKEN=integration-test-token
 *   MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { handleAdmin } from '../src/admin.js';

const TOKEN = 'integration-test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_CT = { 'Content-Type': 'application/json' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminRequest(method, path, body, token = TOKEN) {
  const headers = { ...JSON_CT };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** POST /api/accounts to create a test account and return the parsed body. */
async function createTestAccount(name = 'Test Account') {
  const res = await SELF.fetch(
    adminRequest('POST', '/api/accounts', {
      name,
      location_id: 'loc_test',
      api_key: 'test-ghl-api-key',
    })
  );
  return { res, data: await res.json() };
}

// ── Schema setup ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS accounts (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name              TEXT NOT NULL UNIQUE,
      location_id       TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      api_key_iv        TEXT NOT NULL,
      is_active         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM accounts').run();
});

// ── Admin UI ─────────────────────────────────────────────────────────────────
//
// /admin is gated by Cloudflare Access, not by the bearer token. The test
// environment sets no ACCESS_TEAM_DOMAIN / ACCESS_AUD, so validation fails
// closed and every request is refused with 403. That is the intended
// behaviour for an unconfigured deployment.

describe('GET /admin', () => {
  it('returns 403 with no Cloudflare Access header', async () => {
    const res = await SELF.fetch('http://localhost/admin');
    expect(res.status).toBe(403);
  });

  it('returns 403 with a junk Cloudflare Access header', async () => {
    const res = await SELF.fetch(
      new Request('http://localhost/admin', {
        headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('is not reachable with only a valid bearer token', async () => {
    const res = await SELF.fetch(new Request('http://localhost/admin', { headers: AUTH }));
    expect(res.status).toBe(403);
  });

  it('includes security headers on the refusal', async () => {
    const res = await SELF.fetch('http://localhost/admin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('handleAdmin() renders the management page', async () => {
    const res = handleAdmin();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('GHL MCP');
  });
});

// ── GET /api/accounts ─────────────────────────────────────────────────────────

describe('GET /api/accounts', () => {
  it('returns 401 without auth', async () => {
    const res = await SELF.fetch('http://localhost/api/accounts');
    expect(res.status).toBe(401);
  });

  it('returns an empty array initially', async () => {
    const res = await SELF.fetch(adminRequest('GET', '/api/accounts'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it('does not include api_key_encrypted or api_key_iv in list', async () => {
    await createTestAccount('Safe Account');
    const res = await SELF.fetch(adminRequest('GET', '/api/accounts'));
    const [account] = await res.json();
    expect(account.api_key_encrypted).toBeUndefined();
    expect(account.api_key_iv).toBeUndefined();
  });
});

// ── POST /api/accounts ────────────────────────────────────────────────────────

describe('POST /api/accounts', () => {
  it('creates an account and returns 201 with the account summary', async () => {
    const { res, data } = await createTestAccount('Acme Inc');
    expect(res.status).toBe(201);
    expect(data.name).toBe('Acme Inc');
    expect(data.location_id).toBe('loc_test');
    expect(data.id).toBeTruthy();
    expect(data.api_key_encrypted).toBeUndefined();
    expect(data.api_key_iv).toBeUndefined();
  });

  it('returns 400 when name is missing', async () => {
    const res = await SELF.fetch(
      adminRequest('POST', '/api/accounts', { location_id: 'loc', api_key: 'key' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('name');
  });

  it('returns 400 when location_id is missing', async () => {
    const res = await SELF.fetch(
      adminRequest('POST', '/api/accounts', { name: 'X', api_key: 'key' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('location_id');
  });

  it('returns 400 when api_key is missing', async () => {
    const res = await SELF.fetch(
      adminRequest('POST', '/api/accounts', { name: 'X', location_id: 'loc' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('api_key');
  });

  it('returns 409 when account name already exists', async () => {
    await createTestAccount('Duplicate');
    const { res, data } = await createTestAccount('Duplicate');
    expect(res.status).toBe(409);
    expect(data.error).toContain('Duplicate');
  });

  it('returns 401 without auth', async () => {
    const res = await SELF.fetch(
      adminRequest('POST', '/api/accounts', { name: 'X', location_id: 'L', api_key: 'K' }, null)
    );
    expect(res.status).toBe(401);
  });
});

// ── POST /api/accounts/:id/activate ──────────────────────────────────────────

describe('POST /api/accounts/:id/activate', () => {
  it('sets the account as active and returns { success: true }', async () => {
    const { data: account } = await createTestAccount('Activatable');
    const res = await SELF.fetch(
      adminRequest('POST', `/api/accounts/${account.id}/activate`)
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify the account is now listed as active
    const listRes = await SELF.fetch(adminRequest('GET', '/api/accounts'));
    const [listed] = await listRes.json();
    expect(listed.is_active).toBe(1);
  });
});

// ── DELETE /api/accounts/:id ──────────────────────────────────────────────────

describe('DELETE /api/accounts/:id', () => {
  it('deletes the account and returns { success: true }', async () => {
    const { data: account } = await createTestAccount('Deletable');
    const res = await SELF.fetch(adminRequest('DELETE', `/api/accounts/${account.id}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const listRes = await SELF.fetch(adminRequest('GET', '/api/accounts'));
    expect(await listRes.json()).toHaveLength(0);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await SELF.fetch(adminRequest('DELETE', '/api/accounts/no-such-id'));
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await SELF.fetch(adminRequest('DELETE', '/api/accounts/any-id', undefined, null));
    expect(res.status).toBe(401);
  });
});

// ── PUT /api/accounts/:id ─────────────────────────────────────────────────────

describe('PUT /api/accounts/:id', () => {
  it('updates name and location_id', async () => {
    const { data: account } = await createTestAccount('Original Name');
    const res = await SELF.fetch(
      adminRequest('PUT', `/api/accounts/${account.id}`, {
        name: 'Updated Name',
        location_id: 'loc_new',
      })
    );
    expect(res.status).toBe(200);

    const listRes = await SELF.fetch(adminRequest('GET', '/api/accounts'));
    const [updated] = await listRes.json();
    expect(updated.name).toBe('Updated Name');
    expect(updated.location_id).toBe('loc_new');
  });

  it('returns 400 when no updatable fields are provided', async () => {
    const { data: account } = await createTestAccount('Immutable');
    const res = await SELF.fetch(adminRequest('PUT', `/api/accounts/${account.id}`, {}));
    expect(res.status).toBe(400);
  });
});

// ── Security: response body never leaks key material ─────────────────────────

describe('Security', () => {
  it('never includes api_key_encrypted or api_key_iv in any response', async () => {
    const { data: account } = await createTestAccount('Key Guard');

    const endpoints = [
      adminRequest('GET', '/api/accounts'),
      adminRequest('POST', `/api/accounts/${account.id}/activate`),
    ];

    for (const req of endpoints) {
      const res = await SELF.fetch(req);
      const text = await res.text();
      expect(text).not.toContain('api_key_encrypted');
      expect(text).not.toContain('api_key_iv');
      expect(text).not.toContain('enc_test');
    }
  });
});
