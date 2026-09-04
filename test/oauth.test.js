/**
 * Unit tests for the OAuth 2.0 endpoints.
 *
 * The focus is the redirect_uri allowlist: /oauth/authorize must never issue a
 * redirect to an origin that is not explicitly allowed, because that would make
 * the Worker an open redirect and a signing oracle for attacker-chosen input.
 */

import { describe, it, expect } from 'vitest';
import {
  handleOAuthDiscovery,
  handleOAuthAuthorize,
  handleOAuthToken,
  isAllowedRedirect,
} from '../src/oauth.js';

const TOKEN = 'test-mcp-auth-token';
const ENV = { MCP_AUTH_TOKEN: TOKEN };
const GOOD_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function authorizeUrl(params) {
  const url = new URL('https://worker.example.com/oauth/authorize');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

function tokenRequest(body) {
  return new Request('https://worker.example.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── isAllowedRedirect ────────────────────────────────────────────────────────

describe('isAllowedRedirect', () => {
  it('allows the default Claude origins', () => {
    expect(isAllowedRedirect('https://claude.ai/cb', {})).toBe(true);
    expect(isAllowedRedirect('https://claude.com/cb', {})).toBe(true);
  });

  it('rejects an unrelated origin', () => {
    expect(isAllowedRedirect('https://evil.example.com/cb', {})).toBe(false);
  });

  it('rejects a lookalike suffix domain', () => {
    expect(isAllowedRedirect('https://claude.ai.evil.com/cb', {})).toBe(false);
  });

  it('rejects a lookalike prefix domain', () => {
    expect(isAllowedRedirect('https://notclaude.ai/cb', {})).toBe(false);
  });

  it('rejects http when the allowlist entry is https', () => {
    expect(isAllowedRedirect('http://claude.ai/cb', {})).toBe(false);
  });

  it('rejects a malformed URI', () => {
    expect(isAllowedRedirect('not a url', {})).toBe(false);
    expect(isAllowedRedirect('', {})).toBe(false);
  });

  it('honours a configured allowlist and drops the defaults', () => {
    const env = { OAUTH_REDIRECT_ORIGINS: 'https://app.example.com' };
    expect(isAllowedRedirect('https://app.example.com/cb', env)).toBe(true);
    expect(isAllowedRedirect('https://claude.ai/cb', env)).toBe(false);
  });

  it('accepts a comma-separated list with spaces', () => {
    const env = { OAUTH_REDIRECT_ORIGINS: 'https://a.example.com , https://b.example.com' };
    expect(isAllowedRedirect('https://b.example.com/cb', env)).toBe(true);
  });

  it('falls back to the defaults when the configured list is empty', () => {
    expect(isAllowedRedirect('https://claude.ai/cb', { OAUTH_REDIRECT_ORIGINS: '  ,  ' })).toBe(true);
  });
});

// ── /oauth/authorize ─────────────────────────────────────────────────────────

describe('handleOAuthAuthorize', () => {
  it('redirects to an allowlisted redirect_uri with a code', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: GOOD_REDIRECT, response_type: 'code', state: 'xyz' }),
      ENV
    );
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get('Location'));
    expect(dest.origin).toBe('https://claude.ai');
    expect(dest.searchParams.get('code')).toBeTruthy();
    expect(dest.searchParams.get('state')).toBe('xyz');
  });

  it('returns 400 and no redirect for an off-list redirect_uri', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: 'https://evil.example.com/cb', response_type: 'code' }),
      ENV
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('returns 400 for a lookalike domain', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: 'https://claude.ai.evil.com/cb', response_type: 'code' }),
      ENV
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('does not leak a code in the 400 body', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: 'https://evil.example.com/cb', response_type: 'code' }),
      ENV
    );
    const text = await res.text();
    expect(text).toBe('redirect_uri is not allowed');
  });

  it('returns 400 when redirect_uri is missing', async () => {
    const res = await handleOAuthAuthorize(authorizeUrl({ client_id: 'c1', response_type: 'code' }), ENV);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unsupported response_type', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: GOOD_REDIRECT, response_type: 'token' }),
      ENV
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when MCP_AUTH_TOKEN is not configured', async () => {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: 'c1', redirect_uri: GOOD_REDIRECT, response_type: 'code' }),
      {}
    );
    expect(res.status).toBe(503);
  });
});

// ── /oauth/token ─────────────────────────────────────────────────────────────

describe('handleOAuthToken', () => {
  async function getCode(clientId = 'c1', redirectUri = GOOD_REDIRECT) {
    const res = await handleOAuthAuthorize(
      authorizeUrl({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code' }),
      ENV
    );
    return new URL(res.headers.get('Location')).searchParams.get('code');
  }

  it('exchanges a valid code for the access token', async () => {
    const code = await getCode();
    const res = await handleOAuthToken(
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: 'c1',
        client_secret: TOKEN,
        redirect_uri: GOOD_REDIRECT,
      }),
      ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBe(TOKEN);
    expect(body.token_type).toBe('bearer');
  });

  it('rejects a wrong client_secret', async () => {
    const code = await getCode();
    const res = await handleOAuthToken(
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: 'c1',
        client_secret: 'wrong',
        redirect_uri: GOOD_REDIRECT,
      }),
      ENV
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_client');
  });

  it('rejects an off-list redirect_uri even with the right secret', async () => {
    const res = await handleOAuthToken(
      tokenRequest({
        grant_type: 'authorization_code',
        code: 'anything',
        client_id: 'c1',
        client_secret: TOKEN,
        redirect_uri: 'https://evil.example.com/cb',
      }),
      ENV
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects a code minted for a different redirect_uri', async () => {
    const code = await getCode('c1', 'https://claude.com/cb');
    const res = await handleOAuthToken(
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: 'c1',
        client_secret: TOKEN,
        redirect_uri: GOOD_REDIRECT,
      }),
      ENV
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await handleOAuthToken(
      tokenRequest({ grant_type: 'password', code: 'x', client_id: 'c1', client_secret: TOKEN, redirect_uri: GOOD_REDIRECT }),
      ENV
    );
    const body = await res.json();
    expect(body.error).toBe('unsupported_grant_type');
  });
});

// ── discovery ────────────────────────────────────────────────────────────────

describe('handleOAuthDiscovery', () => {
  it('advertises the endpoints on the request origin', async () => {
    const res = handleOAuthDiscovery(new URL('https://worker.example.com/.well-known/oauth-authorization-server'));
    const body = await res.json();
    expect(body.issuer).toBe('https://worker.example.com');
    expect(body.authorization_endpoint).toBe('https://worker.example.com/oauth/authorize');
    expect(body.token_endpoint).toBe('https://worker.example.com/oauth/token');
  });
});
