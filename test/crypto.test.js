import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from '../src/crypto.js';

// A fixed 32-byte AES-GCM key in base64 for testing (32 zero bytes)
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// A different 32-byte key to verify wrong-key behaviour
const OTHER_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('encryptApiKey / decryptApiKey', () => {
  it('round-trip: decrypt(encrypt(key)) === key', async () => {
    const { encrypted, iv } = await encryptApiKey('my-api-key-12345', MASTER_KEY);
    const result = await decryptApiKey(encrypted, iv, MASTER_KEY);
    expect(result).toBe('my-api-key-12345');
  });

  it('round-trip works for an empty string', async () => {
    const { encrypted, iv } = await encryptApiKey('', MASTER_KEY);
    const result = await decryptApiKey(encrypted, iv, MASTER_KEY);
    expect(result).toBe('');
  });

  it('round-trip works for a long API key', async () => {
    const longKey = 'pk_live_' + 'x'.repeat(200);
    const { encrypted, iv } = await encryptApiKey(longKey, MASTER_KEY);
    const result = await decryptApiKey(encrypted, iv, MASTER_KEY);
    expect(result).toBe(longKey);
  });

  it('produces different ciphertext each call (random IV)', async () => {
    const first = await encryptApiKey('same-key', MASTER_KEY);
    const second = await encryptApiKey('same-key', MASTER_KEY);
    expect(first.encrypted).not.toBe(second.encrypted);
    expect(first.iv).not.toBe(second.iv);
  });

  it('both encrypted and iv are non-empty base64 strings', async () => {
    const { encrypted, iv } = await encryptApiKey('test', MASTER_KEY);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);
    expect(typeof iv).toBe('string');
    expect(iv.length).toBeGreaterThan(0);
  });

  it('decryption with a different master key throws', async () => {
    const { encrypted, iv } = await encryptApiKey('secret-key', MASTER_KEY);
    await expect(decryptApiKey(encrypted, iv, OTHER_KEY)).rejects.toThrow();
  });

  it('decryption with a corrupted ciphertext throws', async () => {
    const { iv } = await encryptApiKey('secret-key', MASTER_KEY);
    await expect(decryptApiKey('bm90YmFzZTY0!!!!', iv, MASTER_KEY)).rejects.toThrow();
  });
});
