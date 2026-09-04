/**
 * GHL API proxy layer.
 *
 * Handles request construction, credential injection, path sanitization,
 * body size limits, and structured error responses for all GHL v2 API calls.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Sanitize and validate an API path to prevent path traversal attacks.
 *
 * Rules:
 * - Must be a string
 * - Must start with /
 * - No ../ sequences
 * - Only URL-safe characters allowed
 *
 * @param {string} path
 * @returns {string} sanitized path
 * @throws {Error} if path is invalid
 */
export function sanitizePath(path) {
  if (typeof path !== 'string') {
    throw new Error('path must be a string');
  }

  // Strip any ../ sequences
  let clean = path.replace(/\.\.\//g, '').replace(/\.\.$/g, '');

  // Collapse multiple slashes
  clean = clean.replace(/\/+/g, '/');

  if (!clean.startsWith('/')) {
    throw new Error('path must start with /');
  }

  // Allow letters, digits, and URL-safe punctuation only
  // Disallow shell-special chars: ; | ` $ { } < > \
  if (!/^[a-zA-Z0-9\-_/.~%?=&+:@,[\]]+$/.test(clean)) {
    throw new Error('path contains invalid characters');
  }

  return clean;
}

/**
 * Execute a proxied request to the GHL v2 API.
 *
 * Automatically injects:
 * - Authorization header with credentials.api_key
 * - Version header (2021-07-28)
 * - locationId query param, always overwriting any caller-supplied value
 * - locationId in the request body, when the caller supplied one
 *
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} path - API path, e.g. /contacts/
 * @param {{ api_key: string, location_id: string }} credentials - resolved GHL credentials
 * @param {{ params?: object, body?: object }} [options]
 * @returns {Promise<{ error: boolean, status: number, data?: any, message?: string, details?: any }>}
 */
export async function ghlRequest(method, path, credentials, { params, body } = {}) {
  const safePath = sanitizePath(path);
  const url = new URL(GHL_BASE + safePath);

  // Append query parameters
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  // Always scope requests to the configured sub-account.
  // This runs AFTER caller-supplied params and overwrites any locationId the
  // caller smuggled in via `path` or `params`, so a tool call can never be
  // aimed at a different GHL sub-account.
  url.searchParams.set('locationId', credentials.location_id);

  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${credentials.api_key}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  };

  // Attach body for mutating methods
  if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
    // Same sub-account lock for the request body: if the caller supplied a
    // locationId, replace it with the configured one.
    const safeBody =
      body && typeof body === 'object' && !Array.isArray(body) && 'locationId' in body
        ? { ...body, locationId: credentials.location_id }
        : body;
    const bodyStr = JSON.stringify(safeBody);
    if (bodyStr.length > MAX_BODY_BYTES) {
      throw new Error('Request body exceeds 1 MB limit');
    }
    init.body = bodyStr;
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return {
      error: true,
      status: res.status,
      message: data?.message ?? 'GHL API error',
      details: data,
    };
  }

  return { error: false, status: res.status, data };
}
