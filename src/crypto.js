/**
 * AES-GCM-256 encryption/decryption for GHL API keys.
 *
 * The MASTER_KEY is a base64-encoded 32-byte key stored as a Cloudflare
 * secret and never appears in source code, logs, or responses.
 *
 * Each API key is encrypted with a unique random 12-byte IV so that
 * identical inputs produce different ciphertexts.
 */

/**
 * Import a raw AES-GCM CryptoKey from a base64-encoded 32-byte string.
 *
 * @param {string} base64Key - base64-encoded 32-byte key (MASTER_KEY secret)
 * @returns {Promise<CryptoKey>}
 */
export async function importMasterKey(base64Key) {
  const bytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a GHL API key string using AES-GCM-256.
 *
 * @param {string} apiKey - plaintext GHL API key
 * @param {string} masterKeyBase64 - base64-encoded MASTER_KEY secret
 * @returns {Promise<{ encrypted: string, iv: string }>} both values base64-encoded
 */
export async function encryptApiKey(apiKey, masterKeyBase64) {
  const key = await importMasterKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

/**
 * Decrypt a GHL API key string using AES-GCM-256.
 *
 * @param {string} encryptedBase64 - base64-encoded ciphertext
 * @param {string} ivBase64 - base64-encoded 12-byte IV
 * @param {string} masterKeyBase64 - base64-encoded MASTER_KEY secret
 * @returns {Promise<string>} plaintext GHL API key
 */
export async function decryptApiKey(encryptedBase64, ivBase64, masterKeyBase64) {
  const key = await importMasterKey(masterKeyBase64);
  const iv = Uint8Array.from(atob(ivBase64), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plaintext);
}
