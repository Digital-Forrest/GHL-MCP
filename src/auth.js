/**
 * Bearer token authentication middleware.
 *
 * Uses a constant-time XOR comparison to prevent timing attacks.
 * The MCP_AUTH_TOKEN is stored as a Cloudflare secret and never
 * appears in source code or logs.
 *
 * @param {Request} request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<boolean>}
 */
export async function validateAuth(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || !env.MCP_AUTH_TOKEN) return false;

  const expected = env.MCP_AUTH_TOKEN;

  // Length check first — but do NOT short-circuit; still run the XOR loop
  // so the function always takes ~O(n) time regardless of match position.
  let diff = token.length ^ expected.length;
  const len = Math.min(token.length, expected.length);
  for (let i = 0; i < len; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0;
}
