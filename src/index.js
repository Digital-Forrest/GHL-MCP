/**
 * Cloudflare Worker entry point for the GHL MCP Server.
 *
 * Routes:
 *   GET  /.well-known/oauth-authorization-server  — OAuth discovery (no auth)
 *   GET  /oauth/authorize                          — OAuth authorization (no auth)
 *   POST /oauth/token                              — OAuth token exchange (no auth)
 *   POST /mcp                                      — MCP protocol endpoint (Bearer auth)
 *   GET  /admin                                    — Account management UI (Cloudflare Access JWT)
 *   *    /api/accounts/*                           — Account REST API (Bearer auth)
 *   GET  /health                                   — Health check (no auth)
 *   *                                              — 404
 *
 * Security headers are applied to every response.
 */

import { validateAuth } from './auth.js';
import { validateAccessJWT } from './access.js';
import { handleMCP } from './mcp.js';
import { handleAdmin, handleAccountsAPI } from './admin.js';
import { handleOAuthDiscovery, handleOAuthAuthorize, handleOAuthToken } from './oauth.js';

/** Applied to every outgoing response to harden the Worker. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * Attach security headers to an existing Response.
 * Returns a new Response so the original is not mutated.
 *
 * @param {Response} response
 * @returns {Response}
 */
function withSecurityHeaders(response) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    next.headers.set(key, value);
  }
  return next;
}

export default {
  /**
   * @param {Request} request
   * @param {object} env - Cloudflare Worker environment bindings
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── OAuth 2.0 endpoints (no auth — these establish auth) ─────────────────
    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return withSecurityHeaders(handleOAuthDiscovery(url));
    }

    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      return withSecurityHeaders(await handleOAuthAuthorize(url, env));
    }

    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      return withSecurityHeaders(await handleOAuthToken(request, env));
    }

    // ── Health check (no auth) ───────────────────────────────────────────────
    if (url.pathname === '/health' && request.method === 'GET') {
      return withSecurityHeaders(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // ── Admin UI ──────────────────────────────────────────────────────────────
    if (url.pathname === '/admin' && request.method === 'GET') {
      const authorized = await validateAccessJWT(request);
      if (!authorized) {
        return withSecurityHeaders(new Response('Forbidden', { status: 403 }));
      }
      return withSecurityHeaders(handleAdmin());
    }

    // ── Account REST API ──────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/accounts')) {
      const authorized = await validateAuth(request, env);
      if (!authorized) {
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer realm="ghl-mcp"',
            },
          })
        );
      }
      const response = await handleAccountsAPI(request, env, url);
      return withSecurityHeaders(response);
    }

    // ── MCP endpoint ─────────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        return withSecurityHeaders(
          new Response('Method Not Allowed', {
            status: 405,
            headers: { Allow: 'POST' },
          })
        );
      }

      const authorized = await validateAuth(request, env);
      if (!authorized) {
        return withSecurityHeaders(
          new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="ghl-mcp"' },
          })
        );
      }

      const response = await handleMCP(request, env);
      return withSecurityHeaders(response);
    }

    // ── Catch-all ─────────────────────────────────────────────────────────────
    return withSecurityHeaders(new Response('Not Found', { status: 404 }));
  },
};
