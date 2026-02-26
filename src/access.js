/**
 * Cloudflare Access JWT validation.
 *
 * Validates the Cf-Access-Jwt-Assertion header on requests to protected
 * routes so they cannot be reached by bypassing Cloudflare Access.
 */

const CERTS_URL = 'https://inboundwizard.cloudflareaccess.com/cdn-cgi/access/certs';
const AUD = '2265e8375cb639a461d7c6ba2b415cbc0ef97c368e1897269a8a3ee9438f2d9e';

// Module-level JWK cache (lives for the Worker instance lifetime)
let cachedKeys = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getPublicKeys() {
  const now = Date.now();
  if (cachedKeys && now - cacheTime < CACHE_TTL_MS) return cachedKeys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error('Failed to fetch Cloudflare Access JWKs');
  const { keys } = await res.json();
  cachedKeys = keys;
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
 * Returns true only if the token is present, unexpired, targets the correct
 * audience, and has a valid RS256 signature from Cloudflare's public keys.
 *
 * @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function validateAccessJWT(request) {
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
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(AUD)) return false;

  // Find the matching public key by key ID
  let keys;
  try {
    keys = await getPublicKeys();
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
