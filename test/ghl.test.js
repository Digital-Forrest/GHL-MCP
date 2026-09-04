import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizePath, ghlRequest } from '../src/ghl.js';

// ghlRequest now accepts a credentials object { api_key, location_id }
const credentials = {
  api_key: 'test-api-key',
  location_id: 'loc_abc123',
};

// ── sanitizePath ─────────────────────────────────────────────────────────────

describe('sanitizePath', () => {
  it('accepts a valid root path', () => {
    expect(sanitizePath('/contacts/')).toBe('/contacts/');
  });

  it('accepts a path with an ID segment', () => {
    expect(sanitizePath('/contacts/abc-123')).toBe('/contacts/abc-123');
  });

  it('accepts a path with query-string-like chars that are part of the path', () => {
    expect(sanitizePath('/contacts/')).toBe('/contacts/');
  });

  it('strips ../ path traversal sequences', () => {
    expect(sanitizePath('/../etc/passwd')).toBe('/etc/passwd');
  });

  it('strips multiple ../ sequences', () => {
    const result = sanitizePath('/contacts/../../secret');
    expect(result).not.toContain('..');
  });

  it('throws when path does not start with /', () => {
    expect(() => sanitizePath('contacts/')).toThrow('path must start with /');
  });

  it('throws when path is not a string', () => {
    expect(() => sanitizePath(123)).toThrow('path must be a string');
    expect(() => sanitizePath(null)).toThrow('path must be a string');
  });

  it('throws on shell-special characters: semicolon', () => {
    expect(() => sanitizePath('/contacts/;rm -rf')).toThrow('invalid characters');
  });

  it('throws on shell-special characters: pipe', () => {
    expect(() => sanitizePath('/contacts/|whoami')).toThrow('invalid characters');
  });

  it('throws on shell-special characters: backtick', () => {
    expect(() => sanitizePath('/contacts/`id`')).toThrow('invalid characters');
  });

  it('throws on dollar sign', () => {
    expect(() => sanitizePath('/contacts/$HOME')).toThrow('invalid characters');
  });

  it('collapses double slashes', () => {
    expect(sanitizePath('//contacts//')).toBe('/contacts/');
  });
});

// ── ghlRequest ───────────────────────────────────────────────────────────────

describe('ghlRequest', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects the Authorization header from credentials.api_key', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ contacts: [] }), { status: 200 }));

    await ghlRequest('GET', '/contacts/', credentials);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer test-api-key');
  });

  it('injects the Version header', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/', credentials);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Version).toBe('2021-07-28');
  });

  it('auto-injects locationId query param from credentials.location_id', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/', credentials);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('locationId=loc_abc123');
  });

  // ── Sub-account lock ───────────────────────────────────────────────────────
  // The server's location_id must always win. A caller must never be able to
  // aim the configured API key at a different GHL sub-account.

  it('overwrites a caller-supplied locationId in params', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/', credentials, { params: { locationId: 'attacker_loc' } });

    const [url] = fetchSpy.mock.calls[0];
    const u = new URL(url);
    const locationIds = u.searchParams.getAll('locationId');
    expect(locationIds).toHaveLength(1);
    expect(locationIds[0]).toBe('loc_abc123');
  });

  it('overwrites a locationId smuggled into the path query string', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/?locationId=attacker_loc', credentials);

    const [url] = fetchSpy.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.getAll('locationId')).toEqual(['loc_abc123']);
    expect(url).not.toContain('attacker_loc');
  });

  it('overwrites a locationId smuggled into the path alongside other params', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/?query=bob&locationId=attacker_loc', credentials);

    const [url] = fetchSpy.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.get('query')).toBe('bob');
    expect(u.searchParams.getAll('locationId')).toEqual(['loc_abc123']);
  });

  it('overwrites a caller-supplied locationId in the request body', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('POST', '/contacts/', credentials, {
      body: { firstName: 'Bob', locationId: 'attacker_loc' },
    });

    const [, init] = fetchSpy.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.locationId).toBe('loc_abc123');
    expect(sent.firstName).toBe('Bob');
  });

  it('leaves a body without locationId untouched', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('POST', '/contacts/', credentials, { body: { firstName: 'Bob' } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ firstName: 'Bob' });
  });

  it('returns { error: false, data } on a 200 response', async () => {
    const mockData = { contacts: [{ id: '1' }] };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(mockData), { status: 200 }));

    const result = await ghlRequest('GET', '/contacts/', credentials);

    expect(result.error).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data).toEqual(mockData);
  });

  it('returns { error: true } on a 4xx response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    );

    const result = await ghlRequest('GET', '/contacts/nonexistent', credentials);

    expect(result.error).toBe(true);
    expect(result.status).toBe(404);
    expect(result.message).toBe('Not Found');
  });

  it('attaches a JSON body for POST requests', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: 'new' }), { status: 200 }));

    await ghlRequest('POST', '/contacts/', credentials, { body: { firstName: 'Jane' } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ firstName: 'Jane' });
  });

  it('does not attach a body for GET requests', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('GET', '/contacts/', credentials, { body: { foo: 'bar' } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('does not attach a body for DELETE requests', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await ghlRequest('DELETE', '/contacts/123', credentials, { body: { foo: 'bar' } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('throws when body exceeds 1 MB', async () => {
    const bigBody = { data: 'x'.repeat(1_048_577) };
    await expect(
      ghlRequest('POST', '/contacts/', credentials, { body: bigBody })
    ).rejects.toThrow('exceeds 1 MB');
  });

  it('throws on an invalid path (passed through to sanitizePath)', async () => {
    await expect(ghlRequest('GET', 'no-leading-slash', credentials)).rejects.toThrow(
      'path must start'
    );
  });
});
