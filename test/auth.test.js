import { describe, it, expect } from 'vitest';
import { validateAuth } from '../src/auth.js';

function makeRequest(authHeader) {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: authHeader ? { Authorization: authHeader } : {},
  });
}

const ENV = { MCP_AUTH_TOKEN: 'super-secret-token-abc123' };

describe('validateAuth', () => {
  it('returns true for a valid token', async () => {
    const req = makeRequest('Bearer super-secret-token-abc123');
    expect(await validateAuth(req, ENV)).toBe(true);
  });

  it('returns false when Authorization header is missing', async () => {
    const req = makeRequest(null);
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('returns false for a wrong token', async () => {
    const req = makeRequest('Bearer wrong-token');
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('returns false when token is present without Bearer prefix', async () => {
    const req = makeRequest('super-secret-token-abc123');
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('returns false for an empty bearer value', async () => {
    const req = makeRequest('Bearer ');
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('returns false when MCP_AUTH_TOKEN secret is not set', async () => {
    const req = makeRequest('Bearer super-secret-token-abc123');
    expect(await validateAuth(req, {})).toBe(false);
  });

  it('returns false for a token that is a prefix of the expected value', async () => {
    const req = makeRequest('Bearer super-secret-token');
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('returns false for a token that extends the expected value', async () => {
    const req = makeRequest('Bearer super-secret-token-abc123-extra');
    expect(await validateAuth(req, ENV)).toBe(false);
  });

  it('is case-sensitive', async () => {
    const req = makeRequest('Bearer SUPER-SECRET-TOKEN-ABC123');
    expect(await validateAuth(req, ENV)).toBe(false);
  });
});
