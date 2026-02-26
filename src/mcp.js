/**
 * MCP (Model Context Protocol) protocol handler.
 *
 * Implements JSON-RPC 2.0 over HTTP POST. Supported methods:
 *   - initialize       — MCP handshake, returns server capabilities
 *   - tools/list       — returns the 5 GHL proxy tool schemas
 *   - tools/call       — executes a tool and proxies to GHL API
 *
 * Error codes follow the JSON-RPC 2.0 spec:
 *   -32700  Parse error
 *   -32600  Invalid request
 *   -32601  Method not found
 *   -32602  Invalid params
 *   -32603  Internal error
 */

import { TOOLS, validateToolArgs } from './tools.js';
import { ghlRequest } from './ghl.js';
import { decryptApiKey } from './crypto.js';
import { getAccountByName, getActiveAccount } from './db.js';

const HTTP_METHOD_MAP = {
  ghl_get: 'GET',
  ghl_post: 'POST',
  ghl_put: 'PUT',
  ghl_patch: 'PATCH',
  ghl_delete: 'DELETE',
};

/**
 * Build a successful JSON-RPC 2.0 response.
 *
 * @param {string|number|null} id
 * @param {any} result
 * @returns {Response}
 */
function jsonRpc(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a JSON-RPC 2.0 error response.
 * Error messages never include stack traces.
 *
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @returns {Response}
 */
function jsonRpcError(id, code, message) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    {
      status: 200, // JSON-RPC errors are still HTTP 200
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Resolve GHL credentials for the named account or the currently active account.
 *
 * Resolution order:
 * 1. accountName provided → D1 lookup by name
 * 2. No accountName → D1 lookup for is_active = 1
 * 3. No D1 result → fall back to GHL_API_KEY + GHL_LOCATION_ID env vars
 * 4. Nothing → throw with a helpful message
 *
 * @param {string|null} accountName
 * @param {object} env - Cloudflare Worker bindings
 * @returns {Promise<{ api_key: string, location_id: string }>}
 */
async function resolveCredentials(accountName, env) {
  if (env.DB) {
    const row = accountName
      ? await getAccountByName(env.DB, accountName)
      : await getActiveAccount(env.DB);

    if (row) {
      const apiKey = await decryptApiKey(row.api_key_encrypted, row.api_key_iv, env.MASTER_KEY);
      return { api_key: apiKey, location_id: row.location_id };
    }

    if (accountName) {
      throw new Error(`Account not found: ${accountName}`);
    }
  }

  // Backward-compatible fallback to individual env var secrets
  if (env.GHL_API_KEY && env.GHL_LOCATION_ID) {
    return { api_key: env.GHL_API_KEY, location_id: env.GHL_LOCATION_ID };
  }

  throw new Error(
    'No active GHL account configured. ' +
      'Visit /admin to add one, or set GHL_API_KEY + GHL_LOCATION_ID Cloudflare secrets.'
  );
}

/**
 * Handle an incoming MCP request.
 *
 * @param {Request} request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<Response>}
 */
export async function handleMCP(request, env) {
  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON');
  }

  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0') {
    return jsonRpcError(rpc?.id ?? null, -32600, 'Invalid JSON-RPC request');
  }

  const { id, method, params } = rpc;

  // ── MCP handshake ──────────────────────────────────────────────────────────
  if (method === 'initialize') {
    return jsonRpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ghl-mcp', version: '1.0.0' },
    });
  }

  // ── List available tools ───────────────────────────────────────────────────
  if (method === 'tools/list') {
    return jsonRpc(id, { tools: TOOLS });
  }

  // ── Execute a tool ─────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};

    if (!name || typeof name !== 'string') {
      return jsonRpcError(id, -32602, 'Missing or invalid tool name');
    }

    try {
      validateToolArgs(name, args);
    } catch (err) {
      return jsonRpcError(id, -32602, err.message);
    }

    const httpMethod = HTTP_METHOD_MAP[name];
    if (!httpMethod) {
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
    }

    // Extract optional account selector and resolve credentials
    const { account: accountName, ...toolArgs } = args;

    let credentials;
    try {
      credentials = await resolveCredentials(accountName ?? null, env);
    } catch (err) {
      return jsonRpcError(id, -32603, err.message);
    }

    let result;
    try {
      result = await ghlRequest(httpMethod, toolArgs.path, credentials, {
        params: toolArgs.params,
        body: toolArgs.body,
      });
    } catch (err) {
      return jsonRpcError(id, -32603, err.message);
    }

    return jsonRpc(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  }

  return jsonRpcError(id ?? null, -32601, `Method not found: ${method}`);
}
