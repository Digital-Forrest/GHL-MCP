/**
 * Minimal OAuth 2.0 authorization code flow for Claude.ai MCP connector.
 *
 * This is a single-tenant implementation — there is no user login screen.
 * The client_secret must match MCP_AUTH_TOKEN; if it does, MCP_AUTH_TOKEN
 * is returned as the access_token. The authorization code is a HMAC-SHA256
 * of (client_id:redirect_uri) keyed on MCP_AUTH_TOKEN, so it cannot be
 * forged and requires no server-side storage.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  — discovery metadata
 *   GET  /oauth/authorize                          — authorization endpoint
 *   POST /oauth/token                              — token endpoint
 */

/**
 * Return OAuth 2.0 authorization server metadata (RFC 8414).
 *
 * @param {URL} url
 * @returns {Response}
 */
export function handleOAuthDiscovery(url) {
  const base = url.origin;
  return new Response(
    JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Authorization endpoint.
 *
 * Redirects immediately to redirect_uri with a signed authorization code.
 * No user interaction required — auth is proven at the token endpoint via client_secret.
 *
 * @param {URL} url
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleOAuthAuthorize(url, env) {
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state') ?? '';
  const responseType = url.searchParams.get('response_type');

  if (!clientId || !redirectUri) {
    return new Response('Missing client_id or redirect_uri', { status: 400 });
  }

  if (responseType !== 'code') {
    return new Response('Only response_type=code is supported', { status: 400 });
  }

  if (!env.MCP_AUTH_TOKEN) {
    return new Response('Server not configured', { status: 503 });
  }

  const code = await signCode(clientId, redirectUri, env.MCP_AUTH_TOKEN);

  const dest = new URL(redirectUri);
  dest.searchParams.set('code', code);
  if (state) dest.searchParams.set('state', state);

  return Response.redirect(dest.toString(), 302);
}

/**
 * Token endpoint.
 *
 * Validates client_secret == MCP_AUTH_TOKEN and the HMAC code signature,
 * then returns MCP_AUTH_TOKEN as the Bearer access_token.
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleOAuthToken(request, env) {
  let params;
  const ct = request.headers.get('Content-Type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    params = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      params = await request.json();
    } catch {
      return tokenError('invalid_request', 'Could not parse request body');
    }
  }

  const { grant_type, code, client_id, client_secret, redirect_uri } = params ?? {};

  if (grant_type !== 'authorization_code') {
    return tokenError('unsupported_grant_type', 'Only authorization_code is supported');
  }

  if (!code || !client_id || !client_secret || !redirect_uri) {
    return tokenError('invalid_request', 'Missing required parameters');
  }

  if (!env.MCP_AUTH_TOKEN) {
    return tokenError('server_error', 'Server not configured');
  }

  if (!timingSafeEqual(client_secret, env.MCP_AUTH_TOKEN)) {
    return tokenError('invalid_client', 'Invalid client_secret');
  }

  const expectedCode = await signCode(client_id, redirect_uri, env.MCP_AUTH_TOKEN);
  if (!timingSafeEqual(code, expectedCode)) {
    return tokenError('invalid_grant', 'Invalid authorization code');
  }

  return new Response(
    JSON.stringify({
      access_token: env.MCP_AUTH_TOKEN,
      token_type: 'bearer',
      expires_in: 86400,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenError(error, description) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Produce a deterministic HMAC-SHA256 authorization code for the given
 * (clientId, redirectUri) pair, keyed on MCP_AUTH_TOKEN.
 *
 * @param {string} clientId
 * @param {string} redirectUri
 * @param {string} secret
 * @returns {Promise<string>} base64-encoded HMAC
 */
async function signCode(clientId, redirectUri, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`${clientId}:${redirectUri}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
