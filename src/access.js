/**
 * Cloudflare Access JWT validation.
 *
 * Validates the Cf-Access-Jwt-Assertion header on requests to protected
 * routes so they cannot be reached by bypassing Cloudflare Access.
 *
 * Configuration comes from the environment, never from source, so the same
 * code can be deployed to any Cloudflare account:
 *
 *   ACCESS_TEAM_DOMAIN  Zero Trust team name, the part before
 *                       .cloudflareaccess.com (e.g. "acme")
 *   ACCESS_AUD          Application Audience (AUD) tag of the Access app
 *
 * Both are set with `wrangler secret put`. If either is missing, validation
 * FAILS CLOSED — a half-configured deployment locks the protected route
 * rather than exposing it.
 */

// Module-level JWK cache, keyed by certs URL so a config change can never
// serve keys fetched for a different team.
let cachedKeys = null;
let cachedUrl = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getPublicKeys(certsUrl) {
  const now = Date.now();
  if (cachedKeys && cachedUrl === certsUrl && now - cacheTime < CACHE_TTL_MS) {
    return cachedKeys;
  }
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error('Failed to fetch Cloudflare Access JWKs');
  const { keys } = await res.json();
  cachedKeys = keys;
  cachedUrl = certsUrl;
  cacheTime = now;
  return keys;
}

function base64urlDecode(str) {
  return Uint8Array.from(
    atob(str.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
}

/**
 * Validate a Cloudflare Access JWT from the incoming request.
 *
 * Returns true only if Access is configured AND the token is present,
 * unexpired, targets the correct audience, and has a valid RS256 signature
 * from Cloudflare's public keys.
 *
 * @param {Request} request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<boolean>}
 */
export async function validateAccessJWT(request, env) {
  // Fail closed when Access is not configured for this deployment.
  const teamDomain = env?.ACCESS_TEAM_DOMAIN;
  const aud = env?.ACCESS_AUD;
  if (!teamDomain || !aud) return false;

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  let header, payload;
  try {
    const dec = new TextDecoder();
    header = JSON.parse(dec.decode(base64urlDecode(parts[0])));
    payload = JSON.parse(dec.decode(base64urlDecode(parts[1])));
  } catch {
    return false;
  }

  // Reject expired tokens
  if (!payload.exp || payload.exp < Date.now() / 1000) return false;

  // Reject tokens not issued for this application
  const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!tokenAud.includes(aud)) return false;

  // Find the matching public key by key ID
  let keys;
  try {
    keys = await getPublicKeys(certsUrl);
  } catch {
    return false;
  }
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return false;

  // Verify the RS256 signature
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig = base64urlDecode(parts[2]);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data);
  } catch {
    return false;
  }
}
