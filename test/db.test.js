import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listAccounts,
  getAccount,
  getAccountByName,
  getActiveAccount,
  createAccount,
  updateAccount,
  setActiveAccount,
  deleteAccount,
} from '../src/db.js';

// Create the table once for the entire test file; rows are cleared between tests.
beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS accounts (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name              TEXT NOT NULL UNIQUE,
      location_id       TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      api_key_iv        TEXT NOT NULL,
      is_active         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM accounts').run();
});

/** Seed helper: create a test account with minimal required fields. */
async function seed(name = 'Test Account', overrides = {}) {
  return createAccount(env.DB, {
    name,
    location_id: 'loc_abc123',
    api_key_encrypted: 'enc_test',
    api_key_iv: 'iv_test',
    ...overrides,
  });
}

// ── listAccounts ──────────────────────────────────────────────────────────────

describe('listAccounts', () => {
  it('returns an empty array when no accounts exist', async () => {
    expect(await listAccounts(env.DB)).toEqual([]);
  });

  it('returns all accounts ordered by created_at ASC', async () => {
    await seed('Alpha');
    await seed('Beta');
    const accounts = await listAccounts(env.DB);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].name).toBe('Alpha');
    expect(accounts[1].name).toBe('Beta');
  });

  it('does not include api_key_encrypted or api_key_iv', async () => {
    await seed('Secure Account');
    const [account] = await listAccounts(env.DB);
    expect(account.api_key_encrypted).toBeUndefined();
    expect(account.api_key_iv).toBeUndefined();
  });
});

// ── createAccount ─────────────────────────────────────────────────────────────

describe('createAccount', () => {
  it('returns the created account summary without key fields', async () => {
    const account = await seed('New Account');
    expect(account.name).toBe('New Account');
    expect(account.location_id).toBe('loc_abc123');
    expect(account.id).toBeTruthy();
    expect(account.is_active).toBe(0);
    expect(account.api_key_encrypted).toBeUndefined();
  });

  it('generates a unique id for each account', async () => {
    const a = await seed('First');
    const b = await seed('Second');
    expect(a.id).not.toBe(b.id);
  });
});

// ── getAccount ────────────────────────────────────────────────────────────────

describe('getAccount', () => {
  it('returns the full row including key fields', async () => {
    const created = await seed('Full Row');
    const row = await getAccount(env.DB, created.id);
    expect(row.name).toBe('Full Row');
    expect(row.api_key_encrypted).toBe('enc_test');
    expect(row.api_key_iv).toBe('iv_test');
  });

  it('returns null for a non-existent id', async () => {
    expect(await getAccount(env.DB, 'no-such-id')).toBeNull();
  });
});

// ── getAccountByName ─────────────────────────────────────────────────────────

describe('getAccountByName', () => {
  it('returns the row when found', async () => {
    await seed('Lookup Me');
    const row = await getAccountByName(env.DB, 'Lookup Me');
    expect(row.name).toBe('Lookup Me');
    expect(row.api_key_encrypted).toBe('enc_test');
  });

  it('returns null for an unknown name', async () => {
    expect(await getAccountByName(env.DB, 'Ghost')).toBeNull();
  });
});

// ── getActiveAccount ─────────────────────────────────────────────────────────

describe('getActiveAccount', () => {
  it('returns null when no account is active', async () => {
    await seed('Inactive');
    expect(await getActiveAccount(env.DB)).toBeNull();
  });

  it('returns the active account', async () => {
    const a = await seed('Active One');
    await setActiveAccount(env.DB, a.id);
    const active = await getActiveAccount(env.DB);
    expect(active.name).toBe('Active One');
  });
});

// ── setActiveAccount ─────────────────────────────────────────────────────────

describe('setActiveAccount', () => {
  it('marks one account as active and deactivates all others', async () => {
    const a = await seed('Account A');
    const b = await seed('Account B');
    const c = await seed('Account C');

    await setActiveAccount(env.DB, a.id);
    expect((await getActiveAccount(env.DB)).name).toBe('Account A');

    await setActiveAccount(env.DB, b.id);
    expect((await getActiveAccount(env.DB)).name).toBe('Account B');

    const all = await listAccounts(env.DB);
    expect(all.find((r) => r.id === a.id).is_active).toBe(0);
    expect(all.find((r) => r.id === c.id).is_active).toBe(0);
  });
});

// ── updateAccount ─────────────────────────────────────────────────────────────

describe('updateAccount', () => {
  it('updates specified fields', async () => {
    const account = await seed('Old Name');
    await updateAccount(env.DB, account.id, { name: 'New Name', location_id: 'loc_updated' });
    const row = await getAccount(env.DB, account.id);
    expect(row.name).toBe('New Name');
    expect(row.location_id).toBe('loc_updated');
  });

  it('does not modify unspecified fields', async () => {
    const account = await seed('Unchanged');
    await updateAccount(env.DB, account.id, { name: 'Changed' });
    const row = await getAccount(env.DB, account.id);
    expect(row.api_key_encrypted).toBe('enc_test');
    expect(row.api_key_iv).toBe('iv_test');
  });

  it('is a no-op when no valid fields are provided', async () => {
    const account = await seed('No Change');
    await expect(updateAccount(env.DB, account.id, {})).resolves.not.toThrow();
    const row = await getAccount(env.DB, account.id);
    expect(row.name).toBe('No Change');
  });
});

// ── deleteAccount ─────────────────────────────────────────────────────────────

describe('deleteAccount', () => {
  it('deletes an existing account and returns true', async () => {
    const account = await seed('Delete Me');
    const result = await deleteAccount(env.DB, account.id);
    expect(result).toBe(true);
    expect(await listAccounts(env.DB)).toHaveLength(0);
  });

  it('returns false for a non-existent id', async () => {
    expect(await deleteAccount(env.DB, 'ghost-id')).toBe(false);
  });
});
