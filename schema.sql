-- GHL MCP accounts table
-- Apply with: wrangler d1 execute ghl-mcp-accounts --file=schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name              TEXT NOT NULL UNIQUE,
  location_id       TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_key_iv        TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
