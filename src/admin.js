/**
 * Admin UI and REST API for managing GHL sub-accounts.
 *
 * Routes handled (auth enforced by index.js before calling these):
 *   GET  /admin                      — HTML management UI
 *   GET  /api/accounts               — list accounts (no key fields)
 *   POST /api/accounts               — create account
 *   PUT  /api/accounts/:id           — update account fields
 *   DELETE /api/accounts/:id         — delete account
 *   POST /api/accounts/:id/activate  — set as active account
 */

import { encryptApiKey } from './crypto.js';
import {
  listAccounts,
  createAccount,
  updateAccount,
  setActiveAccount,
  deleteAccount,
} from './db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function apiError(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ── REST API handler ─────────────────────────────────────────────────────────

/**
 * Handle /api/accounts/* requests.
 *
 * @param {Request} request
 * @param {object} env - Cloudflare Worker bindings
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAccountsAPI(request, env, url) {
  if (!env.DB) {
    return apiError('D1 database not configured', 503);
  }

  // Parse path segments after /api/accounts/
  const parts = url.pathname.replace(/^\/api\/accounts\/?/, '').split('/').filter(Boolean);
  const id = parts[0] ?? null;
  const action = parts[1] ?? null;

  // GET /api/accounts
  if (request.method === 'GET' && !id) {
    const accounts = await listAccounts(env.DB);
    return jsonResponse(accounts);
  }

  // POST /api/accounts — create
  if (request.method === 'POST' && !id) {
    let body;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body');
    }

    const { name, location_id, api_key } = body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) return apiError('name is required');
    if (!location_id || typeof location_id !== 'string' || !location_id.trim()) return apiError('location_id is required');
    if (!api_key || typeof api_key !== 'string' || !api_key.trim()) return apiError('api_key is required');
    if (!env.MASTER_KEY) return apiError('MASTER_KEY secret not configured', 503);

    let encrypted;
    try {
      encrypted = await encryptApiKey(api_key.trim(), env.MASTER_KEY);
    } catch {
      return apiError('Failed to encrypt API key', 500);
    }

    let account;
    try {
      account = await createAccount(env.DB, {
        name: name.trim(),
        location_id: location_id.trim(),
        api_key_encrypted: encrypted.encrypted,
        api_key_iv: encrypted.iv,
      });
    } catch (err) {
      if (err?.message?.includes('UNIQUE')) {
        return apiError(`Account name "${name.trim()}" already exists`, 409);
      }
      return apiError('Failed to create account', 500);
    }

    return jsonResponse(account, 201);
  }

  // POST /api/accounts/:id/activate
  if (request.method === 'POST' && id && action === 'activate') {
    try {
      await setActiveAccount(env.DB, id);
    } catch {
      return apiError('Failed to activate account', 500);
    }
    return jsonResponse({ success: true });
  }

  // PUT /api/accounts/:id — update
  if (request.method === 'PUT' && id && !action) {
    let body;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body');
    }

    const fields = {};
    if (body.name) fields.name = body.name.trim();
    if (body.location_id) fields.location_id = body.location_id.trim();

    if (body.api_key) {
      if (!env.MASTER_KEY) return apiError('MASTER_KEY secret not configured', 503);
      let encrypted;
      try {
        encrypted = await encryptApiKey(body.api_key.trim(), env.MASTER_KEY);
      } catch {
        return apiError('Failed to encrypt API key', 500);
      }
      fields.api_key_encrypted = encrypted.encrypted;
      fields.api_key_iv = encrypted.iv;
    }

    if (Object.keys(fields).length === 0) return apiError('No valid fields to update');

    try {
      await updateAccount(env.DB, id, fields);
    } catch (err) {
      if (err?.message?.includes('UNIQUE')) {
        return apiError(`Account name "${fields.name}" already exists`, 409);
      }
      return apiError('Failed to update account', 500);
    }

    return jsonResponse({ success: true });
  }

  // DELETE /api/accounts/:id
  if (request.method === 'DELETE' && id && !action) {
    let deleted;
    try {
      deleted = await deleteAccount(env.DB, id);
    } catch {
      return apiError('Failed to delete account', 500);
    }
    if (!deleted) return apiError('Account not found', 404);
    return jsonResponse({ success: true });
  }

  return apiError('Not found', 404);
}

// ── Admin HTML UI ─────────────────────────────────────────────────────────────

/**
 * Serve the account management UI at GET /admin.
 *
 * The page is fully self-contained (no external dependencies).
 * The bearer token is stored in sessionStorage (per-tab only).
 * All account data is rendered via DOM APIs — no innerHTML with server data.
 *
 * @returns {Response}
 */
export function handleAdmin() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GHL MCP — Account Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .hidden { display: none !important; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f4f4f5; color: #18181b; min-height: 100vh; padding: 2rem 1rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 2rem; letter-spacing: -0.01em; }

    /* Token overlay */
    #token-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
    .token-card { background: #fff; border-radius: 10px; padding: 2rem; width: min(420px, 92vw); box-shadow: 0 8px 32px rgba(0,0,0,0.18); }
    .token-card h2 { font-size: 1.05rem; font-weight: 700; margin-bottom: 0.5rem; }
    .token-card p { font-size: 0.82rem; color: #71717a; margin-bottom: 1.25rem; line-height: 1.5; }

    /* Layout */
    #main { max-width: 680px; margin: 0 auto; }
    .card { background: #fff; border-radius: 10px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.07); margin-bottom: 1.25rem; }

    /* Form */
    label { display: block; font-size: 0.78rem; font-weight: 600; color: #52525b; margin-bottom: 0.3rem; letter-spacing: 0.01em; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 0.5rem 0.75rem; border: 1.5px solid #e4e4e7; border-radius: 6px;
      font-size: 0.875rem; outline: none; transition: border-color 0.15s; background: #fafafa;
    }
    input:focus { border-color: #6366f1; background: #fff; }
    .field { margin-bottom: 0.85rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1rem; }
    .full-col { grid-column: 1 / -1; }
    @media (max-width: 500px) { .form-grid { grid-template-columns: 1fr; } .full-col { grid-column: 1; } }

    /* Buttons */
    button { cursor: pointer; border: none; border-radius: 6px; font-size: 0.82rem; font-weight: 600; padding: 0.45rem 0.9rem; transition: background 0.15s, opacity 0.15s; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #4f46e5; }
    .btn-activate { background: #22c55e; color: #fff; }
    .btn-activate:hover:not(:disabled) { background: #16a34a; }
    .btn-delete { background: #ef4444; color: #fff; }
    .btn-delete:hover:not(:disabled) { background: #dc2626; }
    .btn-sm { padding: 0.3rem 0.65rem; font-size: 0.77rem; }
    .btn-ghost { background: #f4f4f5; color: #3f3f46; }
    .btn-ghost:hover:not(:disabled) { background: #e4e4e7; }

    /* Account list */
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .section-header h2 { font-size: 0.95rem; font-weight: 700; }
    #account-list { display: flex; flex-direction: column; gap: 0.6rem; }
    .account-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.85rem 1rem; background: #fafafa; border: 1.5px solid #e4e4e7; border-radius: 7px; }
    .account-row.is-active { border-color: #a5f3c0; background: #f0fdf4; }
    .account-info { flex: 1; min-width: 0; }
    .account-name { font-weight: 600; font-size: 0.9rem; }
    .account-location { font-size: 0.75rem; color: #71717a; margin-top: 2px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { display: inline-block; font-size: 0.68rem; font-weight: 700; padding: 1px 7px; border-radius: 999px; vertical-align: 2px; margin-left: 6px; background: #dcfce7; color: #15803d; }
    .account-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
    .empty-msg { text-align: center; color: #a1a1aa; font-size: 0.85rem; padding: 1.5rem 0; }

    /* Alerts */
    .alert { border-radius: 6px; font-size: 0.82rem; padding: 0.6rem 0.85rem; margin-bottom: 0.85rem; }
    .alert-ok { background: #dcfce7; color: #15803d; }
    .alert-err { background: #fee2e2; color: #b91c1c; }

    /* Footer */
    .footer-link { text-align: right; font-size: 0.72rem; color: #a1a1aa; margin-top: -0.5rem; margin-bottom: 1rem; }
    .footer-link a { color: #a1a1aa; text-decoration: none; }
    .footer-link a:hover { color: #6366f1; }
  </style>
</head>
<body>

  <!-- Bearer token prompt -->
  <div id="token-overlay">
    <div class="token-card">
      <h2>Enter your MCP Auth Token</h2>
      <p>This is your <code>MCP_AUTH_TOKEN</code> Cloudflare secret. It will be stored in sessionStorage for this browser tab only and is never sent anywhere except back to this Worker.</p>
      <div class="field">
        <label for="token-input">Bearer Token</label>
        <input type="password" id="token-input" placeholder="Paste token here" autocomplete="off">
      </div>
      <button class="btn-primary" id="token-save" style="width:100%">Save &amp; Continue</button>
    </div>
  </div>

  <!-- Main UI -->
  <div id="main" class="hidden">
    <h1>GHL MCP &mdash; Account Manager</h1>

    <div class="card">
      <div class="section-header">
        <h2>Connected Accounts</h2>
        <button class="btn-ghost btn-sm" id="refresh-btn">Refresh</button>
      </div>
      <div id="list-alert" class="alert hidden"></div>
      <div id="account-list"><div class="empty-msg">Loading&hellip;</div></div>
    </div>

    <div class="card">
      <h2 style="font-size:0.95rem;font-weight:700;margin-bottom:1rem;">Add Account</h2>
      <div id="add-alert" class="alert hidden"></div>
      <form id="add-form" autocomplete="off">
        <div class="form-grid">
          <div class="field">
            <label for="f-name">Account Name</label>
            <input type="text" id="f-name" placeholder="e.g. Acme Realty" required>
          </div>
          <div class="field">
            <label for="f-location">Location ID</label>
            <input type="text" id="f-location" placeholder="GHL sub-account location ID" required>
          </div>
          <div class="field full-col">
            <label for="f-key">GHL Private Integration API Key</label>
            <input type="password" id="f-key" placeholder="Paste key — encrypted before storage" required autocomplete="new-password">
          </div>
          <div class="full-col" style="display:flex;justify-content:flex-end;margin-top:0.25rem;">
            <button type="submit" class="btn-primary" id="add-btn">Add Account</button>
          </div>
        </div>
      </form>
    </div>

    <div class="footer-link"><a href="#" id="change-token">Change auth token</a></div>
  </div>

  <script>
    'use strict';
    const TOKEN_KEY = 'ghl_mcp_token';
    const getToken = () => sessionStorage.getItem(TOKEN_KEY);
    const setToken = t => sessionStorage.setItem(TOKEN_KEY, t);
    const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

    // ── Token flow ────────────────────────────────────────────────────────────
    function showPrompt() {
      document.getElementById('token-overlay').classList.remove('hidden');
      document.getElementById('main').classList.add('hidden');
      const inp = document.getElementById('token-input');
      inp.value = '';
      setTimeout(() => inp.focus(), 50);
    }
    function showMain() {
      document.getElementById('token-overlay').classList.add('hidden');
      document.getElementById('main').classList.remove('hidden');
    }

    document.getElementById('token-save').addEventListener('click', () => {
      const t = document.getElementById('token-input').value.trim();
      if (!t) return;
      setToken(t);
      showMain();
      loadAccounts();
    });
    document.getElementById('token-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('token-save').click();
    });
    document.getElementById('change-token').addEventListener('click', e => {
      e.preventDefault();
      clearToken();
      showPrompt();
    });

    // ── API wrapper ───────────────────────────────────────────────────────────
    async function api(method, path, body) {
      const opts = {
        method,
        headers: { Authorization: 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      if (res.status === 401) {
        clearToken();
        showPrompt();
        const err = new Error('auth');
        err.isAuth = true;
        throw err;
      }
      return res;
    }

    // ── Alerts ────────────────────────────────────────────────────────────────
    function showAlert(elId, msg, type) {
      const el = document.getElementById(elId);
      el.textContent = msg;
      el.className = 'alert ' + (type === 'ok' ? 'alert-ok' : 'alert-err');
      el.classList.remove('hidden');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.add('hidden'), 5000);
    }

    // ── Render accounts (DOM-safe — no innerHTML with server data) ────────────
    function setListContent(text) {
      const list = document.getElementById('account-list');
      list.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.textContent = text;
      list.appendChild(msg);
    }

    function renderAccounts(accounts) {
      const list = document.getElementById('account-list');
      list.textContent = '';

      if (!accounts.length) {
        setListContent('No accounts yet — add one below.');
        return;
      }

      for (const a of accounts) {
        const row = document.createElement('div');
        row.className = 'account-row' + (a.is_active ? ' is-active' : '');
        row.dataset.id = a.id;
        row.dataset.name = a.name;

        // Info column
        const info = document.createElement('div');
        info.className = 'account-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'account-name';
        nameEl.textContent = a.name;
        if (a.is_active) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Active';
          nameEl.appendChild(badge);
        }

        const locEl = document.createElement('div');
        locEl.className = 'account-location';
        locEl.textContent = a.location_id;

        info.appendChild(nameEl);
        info.appendChild(locEl);

        // Actions column
        const actions = document.createElement('div');
        actions.className = 'account-actions';

        if (!a.is_active) {
          const activateBtn = document.createElement('button');
          activateBtn.className = 'btn-activate btn-sm';
          activateBtn.textContent = 'Set Active';
          activateBtn.addEventListener('click', () => doActivate(a.id, activateBtn));
          actions.appendChild(activateBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete btn-sm';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => doDelete(a.id, a.name, deleteBtn));
        actions.appendChild(deleteBtn);

        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
      }
    }

    // ── Load accounts ─────────────────────────────────────────────────────────
    async function loadAccounts() {
      setListContent('Loading\u2026');
      try {
        const res = await api('GET', '/api/accounts');
        const data = await res.json();
        if (!res.ok) { showAlert('list-alert', data.error || 'Failed to load.', 'err'); return; }
        renderAccounts(data);
      } catch (err) {
        if (!err.isAuth) setListContent('Failed to load accounts.');
      }
    }

    // ── Activate ──────────────────────────────────────────────────────────────
    async function doActivate(id, btn) {
      btn.disabled = true;
      btn.textContent = 'Saving\u2026';
      try {
        const res = await api('POST', '/api/accounts/' + encodeURIComponent(id) + '/activate');
        const data = await res.json();
        if (!res.ok) { showAlert('list-alert', data.error || 'Failed to activate.', 'err'); btn.disabled = false; btn.textContent = 'Set Active'; return; }
        showAlert('list-alert', 'Account set as active.', 'ok');
        loadAccounts();
      } catch (err) {
        if (!err.isAuth) { showAlert('list-alert', 'Failed to activate.', 'err'); btn.disabled = false; btn.textContent = 'Set Active'; }
      }
    }

    // ── Delete ────────────────────────────────────────────────────────────────
    async function doDelete(id, name, btn) {
      if (!confirm('Delete account "' + name + '"? This cannot be undone.')) return;
      btn.disabled = true;
      btn.textContent = 'Deleting\u2026';
      try {
        const res = await api('DELETE', '/api/accounts/' + encodeURIComponent(id));
        const data = await res.json();
        if (!res.ok) { showAlert('list-alert', data.error || 'Failed to delete.', 'err'); btn.disabled = false; btn.textContent = 'Delete'; return; }
        showAlert('list-alert', 'Account deleted.', 'ok');
        loadAccounts();
      } catch (err) {
        if (!err.isAuth) { showAlert('list-alert', 'Failed to delete.', 'err'); btn.disabled = false; btn.textContent = 'Delete'; }
      }
    }

    // ── Add form ──────────────────────────────────────────────────────────────
    document.getElementById('add-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('add-btn');
      const name = document.getElementById('f-name').value.trim();
      const location_id = document.getElementById('f-location').value.trim();
      const api_key = document.getElementById('f-key').value.trim();
      btn.disabled = true;
      btn.textContent = 'Adding\u2026';
      try {
        const res = await api('POST', '/api/accounts', { name, location_id, api_key });
        const data = await res.json();
        if (!res.ok) { showAlert('add-alert', data.error || 'Failed to add account.', 'err'); return; }
        showAlert('add-alert', 'Account "' + name + '" added successfully.', 'ok');
        document.getElementById('add-form').reset();
        loadAccounts();
      } catch (err) {
        if (!err.isAuth) showAlert('add-alert', 'Failed to add account.', 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Add Account';
      }
    });

    document.getElementById('refresh-btn').addEventListener('click', loadAccounts);

    // ── Init ──────────────────────────────────────────────────────────────────
    if (getToken()) { showMain(); loadAccounts(); } else { showPrompt(); }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
