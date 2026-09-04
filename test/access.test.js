/**
 * Unit tests for Cloudflare Access JWT validation.
 *
 * The "valid token" case generates a real RSA key pair with WebCrypto, signs
 * a real RS256 JWT, and stubs globalThis.fetch so the JWK endpoint serves the
 * matching public key. That exercises the whole signature path, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateAccessJWT } from '../src/access.js';

const AUD = 'test-aud-tag';

// access.js caches JWKs per certs URL for an hour. Give every test its own
// team domain so one test's cached keys can never leak into the next.
let teamCounter = 0;
function freshTeam() {
  return { team: `test-team-${++teamCounter}`, aud: AUD };
}
function envFor({ team, aud = AUD }) {
  return { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud };
}
function certsUrlFor(team) {
  return `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

const TEAM = 'static-test-team';
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64url(bytes) {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requestWith(token) {
  const headers = token ? { 'Cf-Access-Jwt-Assertion': token } : {};
  return new Request('http://localhost/admin', { headers });
}

/** Generate a key pair and return { jwk, sign(header, payload) }. */
async function makeSigner(kid = 'test-kid') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';

  async function sign(payload, headerOverrides = {}) {
    const header = { alg: 'RS256', kid, ...headerOverrides };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${b64url(sig)}`;
  }

  return { jwk, sign };
}

/** Stub global fetch so the given certs URL serves the given JWKs. */
function stubCerts(certsUrl, keys) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === certsUrl) {
      return new Response(JSON.stringify({ keys }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Fail-closed configuration ────────────────────────────────────────────────

describe('validateAccessJWT — configuration', () => {
  it('returns false when env is undefined', async () => {
    expect(await validateAccessJWT(requestWith('a.b.c'), undefined)).toBe(false);
  });

  it('returns false when ACCESS_TEAM_DOMAIN is missing', async () => {
    expect(await validateAccessJWT(requestWith('a.b.c'), { ACCESS_AUD: AUD })).toBe(false);
  });

  it('returns false when ACCESS_AUD is missing', async () => {
    expect(await validateAccessJWT(requestWith('a.b.c'), { ACCESS_TEAM_DOMAIN: TEAM })).toBe(false);
  });

  it('does not fetch the certs URL when unconfigured', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await validateAccessJWT(requestWith('a.b.c'), {});
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Malformed tokens ─────────────────────────────────────────────────────────

describe('validateAccessJWT — malformed tokens', () => {
  it('returns false with no Cf-Access-Jwt-Assertion header', async () => {
    expect(await validateAccessJWT(requestWith(null), ENV)).toBe(false);
  });

  it('returns false when the token is not three parts', async () => {
    expect(await validateAccessJWT(requestWith('only.two'), ENV)).toBe(false);
  });

  it('returns false when the token segments are not valid JSON', async () => {
    expect(await validateAccessJWT(requestWith('bm90anNvbg.bm90anNvbg.c2ln'), ENV)).toBe(false);
  });
});

// ── Claim checks ─────────────────────────────────────────────────────────────

describe('validateAccessJWT — claims', () => {
  let signer;
  let team;
  let env;

  beforeEach(async () => {
    signer = await makeSigner();
    ({ team } = freshTeam());
    env = envFor({ team });
  });

  it('returns false when the token is expired', async () => {
    stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: [AUD], exp: past() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns false when exp is missing', async () => {
    stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: [AUD] });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns false when the audience does not match', async () => {
    stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: ['some-other-app'], exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns false when no public key matches the kid', async () => {
    const other = await makeSigner('different-kid');
    stubCerts(certsUrlFor(team), [other.jwk]);
    const token = await signer.sign({ aud: [AUD], exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns false when the signature was made by a different key', async () => {
    const impostor = await makeSigner('test-kid');
    stubCerts(certsUrlFor(team), [signer.jwk]); // serve the real key
    const token = await impostor.sign({ aud: [AUD], exp: future() }); // signed by the wrong one
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns false when the certs endpoint fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const token = await signer.sign({ aud: [AUD], exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(false);
  });

  it('returns true for a correctly signed, unexpired, correctly scoped token', async () => {
    stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: [AUD], exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(true);
  });

  it('accepts aud supplied as a bare string', async () => {
    stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: AUD, exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(true);
  });

  it('caches JWKs so a second call does not refetch', async () => {
    const spy = stubCerts(certsUrlFor(team), [signer.jwk]);
    const token = await signer.sign({ aud: [AUD], exp: future() });
    expect(await validateAccessJWT(requestWith(token), env)).toBe(true);
    expect(await validateAccessJWT(requestWith(token), env)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
