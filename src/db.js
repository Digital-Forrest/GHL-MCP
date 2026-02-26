/**
 * D1 database operations for GHL sub-account management.
 *
 * All queries use prepared statements with .bind() — no string interpolation.
 * API key fields (api_key_encrypted, api_key_iv) are never returned by
 * listAccounts; they are only fetched when needed for decryption.
 *
 * @typedef {{ id: string, name: string, location_id: string, is_active: number, created_at: string, updated_at: string }} AccountSummary
 * @typedef {AccountSummary & { api_key_encrypted: string, api_key_iv: string }} AccountRow
 */

/**
 * List all accounts. Does NOT include api_key_encrypted or api_key_iv.
 *
 * @param {D1Database} db
 * @returns {Promise<AccountSummary[]>}
 */
export async function listAccounts(db) {
  const { results } = await db
    .prepare('SELECT id, name, location_id, is_active, created_at, updated_at FROM accounts ORDER BY created_at ASC')
    .all();
  return results ?? [];
}

/**
 * Get one account by ID (includes encrypted key fields for decryption).
 *
 * @param {D1Database} db
 * @param {string} id
 * @returns {Promise<AccountRow|null>}
 */
export async function getAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
}

/**
 * Get one account by name (includes encrypted key fields for decryption).
 *
 * @param {D1Database} db
 * @param {string} name
 * @returns {Promise<AccountRow|null>}
 */
export async function getAccountByName(db, name) {
  return db.prepare('SELECT * FROM accounts WHERE name = ?').bind(name).first();
}

/**
 * Get the currently active account (includes encrypted key fields).
 *
 * @param {D1Database} db
 * @returns {Promise<AccountRow|null>}
 */
export async function getActiveAccount(db) {
  return db.prepare('SELECT * FROM accounts WHERE is_active = 1 LIMIT 1').first();
}

/**
 * Create a new account. The api_key must already be encrypted before calling this.
 *
 * @param {D1Database} db
 * @param {{ name: string, location_id: string, api_key_encrypted: string, api_key_iv: string }} fields
 * @returns {Promise<AccountSummary>} the created account (without key fields)
 */
export async function createAccount(db, { name, location_id, api_key_encrypted, api_key_iv }) {
  await db
    .prepare(
      `INSERT INTO accounts (name, location_id, api_key_encrypted, api_key_iv)
       VALUES (?, ?, ?, ?)`
    )
    .bind(name, location_id, api_key_encrypted, api_key_iv)
    .run();

  return db
    .prepare('SELECT id, name, location_id, is_active, created_at, updated_at FROM accounts WHERE name = ?')
    .bind(name)
    .first();
}

/**
 * Update account fields. Only provided fields are updated.
 * Does not touch is_active — use setActiveAccount for that.
 *
 * @param {D1Database} db
 * @param {string} id
 * @param {{ name?: string, location_id?: string, api_key_encrypted?: string, api_key_iv?: string }} fields
 * @returns {Promise<void>}
 */
export async function updateAccount(db, id, fields) {
  const allowed = ['name', 'location_id', 'api_key_encrypted', 'api_key_iv'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  await db
    .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

/**
 * Set one account as active and deactivate all others atomically.
 *
 * @param {D1Database} db
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function setActiveAccount(db, id) {
  await db.batch([
    db.prepare("UPDATE accounts SET is_active = 0, updated_at = datetime('now')"),
    db.prepare("UPDATE accounts SET is_active = 1, updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
}

/**
 * Delete an account by ID.
 *
 * @param {D1Database} db
 * @param {string} id
 * @returns {Promise<boolean>} true if a row was deleted
 */
export async function deleteAccount(db, id) {
  const result = await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
