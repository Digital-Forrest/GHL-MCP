# GHL MCP Server

A custom MCP (Model Context Protocol) server that wraps the GoHighLevel v2 REST API, deployed to Cloudflare Workers. Gives Claude full, reliable access to one or more GHL sub-accounts via natural language.

Nothing in this repo is tied to a specific Cloudflare account. Every account-specific value is a secret or a placeholder, so the same code can be deployed to any account.

## Architecture

```
Claude (MCP Client)
       │
       ▼
[Bearer Token Auth]
Cloudflare Worker — POST /mcp  (JSON-RPC 2.0)
       │
       ▼
[Active account credentials looked up from D1]
https://services.leadconnectorhq.com  (GHL v2 API)

Browser (Admin UI)
       │
       ▼
[Cloudflare Access — identity gate]
Cloudflare Worker — GET /admin
       │
       ▼
[Bearer Token Auth for API calls]
GET|POST|PUT|DELETE /api/accounts/*
```

## Tools

Five generic proxy tools cover 100% of the GHL v2 API:

| Tool | Method | Description |
|---|---|---|
| `ghl_get` | GET | Read any GHL resource |
| `ghl_post` | POST | Create any GHL resource |
| `ghl_put` | PUT | Full update of any GHL resource |
| `ghl_patch` | PATCH | Partial update of any GHL resource |
| `ghl_delete` | DELETE | Delete any GHL resource |

The `locationId` is always injected server-side from the active account. Claude never needs to pass it, and a caller cannot override it.

## Security

- **Layer 1 — MCP Bearer Token:** Every `/mcp` and `/api/accounts/*` request must include `Authorization: Bearer <MCP_AUTH_TOKEN>`. Validated with a constant-time comparison to prevent timing attacks.
- **Layer 2 — Cloudflare Access:** The `/admin` page is gated by Cloudflare Access. The Worker also validates the `Cf-Access-Jwt-Assertion` JWT (RS256, audience-checked) to prevent direct bypasses. Validation **fails closed**: if `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, `/admin` returns 403 for everyone.
- **Layer 3 — GHL credentials:** Per-account API keys stored in D1 are AES-256-GCM encrypted at rest. Keys never appear in source code, logs, or API responses.
- **Sub-account lock:** The configured `locationId` always wins. A caller cannot redirect a request to a different sub-account through the path, the query params, or the request body.
- **OAuth redirect allowlist:** `/oauth/authorize` only redirects to origins on an allowlist (`https://claude.ai` and `https://claude.com` by default). It is not an open redirect.
- **Path sanitization:** Strips `../` traversal sequences and rejects shell-special characters.
- **Body size limit:** Requests over 1 MB are rejected before they reach the GHL API.
- **No stack traces:** Error responses return a safe message string, never internal state.
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Cache-Control: no-store` on every response.

> **Treat `MCP_AUTH_TOKEN` like a password.** It is both the Claude connector token and the admin API key. Anyone holding it can add, change, or delete stored GHL accounts through `/api/accounts`.

> **The OAuth access token does not self-expire.** The token endpoint returns `MCP_AUTH_TOKEN` itself. To revoke access, rotate the `MCP_AUTH_TOKEN` secret and redeploy.

## Configuration reference

Set every one of these with `wrangler secret put <NAME>`. None of them belong in a file you commit.

| Secret | Required | What it is |
|---|---|---|
| `MCP_AUTH_TOKEN` | Yes | Bearer token for `/mcp` and `/api/accounts`. Random 32-byte hex. |
| `MASTER_KEY` | Yes | AES-256 key for API keys stored in D1. **Must be base64**, not hex. |
| `ACCESS_TEAM_DOMAIN` | Yes | Zero Trust team name, the part before `.cloudflareaccess.com`. |
| `ACCESS_AUD` | Yes | Application Audience (AUD) tag of the Access app protecting `/admin`. |
| `OAUTH_REDIRECT_ORIGINS` | No | Comma-separated origins allowed as OAuth redirect targets. Defaults to `https://claude.ai,https://claude.com`. |
| `GHL_API_KEY` | No | Fallback GHL key, used only when no account row exists in D1. |
| `GHL_LOCATION_ID` | No | Fallback GHL location ID, paired with the above. |

`wrangler.toml` holds only the D1 `database_id`, which you fill in during setup. It is an identifier, not a credential.

## Setup

Commands are given for **macOS / Linux** and **Windows PowerShell**. On Windows use `curl.exe`, not `curl`. Plain `curl` in PowerShell is an alias for a different command and will not work.

### 1. Install dependencies

```bash
npm install
```

### 2. Choose the Cloudflare account

```bash
npx wrangler whoami
```

Copy the account ID you want to deploy into.

macOS / Linux:

```bash
export CLOUDFLARE_ACCOUNT_ID=paste_account_id_here
```

Windows PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "paste_account_id_here"
```

### 3. Create the D1 database

```bash
npx wrangler d1 create ghl-mcp-accounts
```

Copy the returned `database_id` into `wrangler.toml`, replacing the placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ghl-mcp-accounts"
database_id = "<your-database-id>"
```

Apply the schema:

```bash
npx wrangler d1 execute ghl-mcp-accounts --remote --file=schema.sql
```

### 4. Generate the two random keys

macOS / Linux:

```bash
openssl rand -hex 32
```

```bash
openssl rand -base64 32
```

Windows PowerShell (no openssl needed):

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
"MCP_AUTH_TOKEN: " + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
$k = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k)
"MASTER_KEY: " + [Convert]::ToBase64String($k)
```

The hex value is `MCP_AUTH_TOKEN`. Save it, Claude needs it later.
The base64 value is `MASTER_KEY`. **It must be base64.** A hex key is the wrong length and encryption will fail.

### 5. Set the first two secrets

```bash
npx wrangler secret put MCP_AUTH_TOKEN
```

```bash
npx wrangler secret put MASTER_KEY
```

**Getting GHL credentials** (needed later, in the admin UI):
- Go to the sub-account → Settings → Integrations → Private Integrations
- Create a new integration and copy the API key
- The location ID is in the sub-account URL, or under Settings → Business Profile

### 6. First deploy

```bash
npm run deploy
```

Note the URL: `https://ghl-mcp.<your-subdomain>.workers.dev`.

`/admin` returns 403 at this point. That is correct. Access is not configured yet, and the Worker fails closed.

### 7. Configure Cloudflare Access

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → your account → **Zero Trust**
2. **Access → Applications → Add an application → Self-hosted**
   - Application domain: `ghl-mcp.<your-subdomain>.workers.dev`
   - Path: `admin`
3. Create a policy (Action: **Allow**, Selector: **Emails** → your email)
4. Copy the **Application Audience (AUD) Tag** from the application settings
5. Your team domain is the `<team>` in `<team>.cloudflareaccess.com`

> **Do not use the "Protect this Worker" toggle in the Workers dashboard.** That puts Access in front of the whole Worker, including `/mcp`, and Claude will stop working. Protect the hostname plus the `admin` path only, as above.

### 8. Set the Access secrets and redeploy

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
```

```bash
npx wrangler secret put ACCESS_AUD
```

```bash
npm run deploy
```

`/admin` now asks you to sign in.

### 9. Connect Claude

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ghl-mcp": {
      "url": "https://ghl-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your_mcp_auth_token>"
      }
    }
  }
}
```

Restart Claude. The 5 GHL tools appear automatically.

## Local development

```bash
cp .dev.vars.example .dev.vars
```

Windows PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Fill in `MCP_AUTH_TOKEN` and `MASTER_KEY`, then:

```bash
npm run dev
```

Smoke test, macOS / Linux:

```bash
curl -s -X POST http://localhost:8787/mcp -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Smoke test, Windows PowerShell:

```powershell
curl.exe -s -X POST http://localhost:8787/mcp -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
```

> **`/admin` returns 403 locally.** Cloudflare Access does not run in local dev, so no `Cf-Access-Jwt-Assertion` header is present and validation fails closed. This is intentional. Test the admin UI on a deployed environment behind a real Access application.

## Tests

```bash
npm test
```

```bash
npm run test:watch
```

## GHL API coverage

All GHL v2 API categories are accessible via the proxy tools:

- Contacts (search, create, update, delete, tags, notes, tasks, appointments)
- Conversations (messages, SMS, email, WhatsApp, recordings)
- Calendars (slots, appointments, groups, resources)
- Opportunities (pipelines, stages, followers)
- Payments (orders, transactions, subscriptions, products, invoices)
- Locations, Users, Workflows, Forms, Surveys
- Funnels, Blogs, Media Library, Trigger Links
- Custom Fields v2, Custom Objects/CRM, Businesses
- Social Planner, Email, Certificates, Documents & Contracts
- Knowledge Base, Custom Menus, OAuth/Tokens

### Confirmed API gaps (not available via API)

- Workflow builder (cannot create/edit workflow steps)
- Funnel/website page content editing
- Email builder editor data retrieval
- Courses/memberships
- Full reporting dashboards
- Pipeline/stage creation

## Rate limits

- Burst: 100 requests / 10 seconds / app / location
- Daily: 200,000 requests / day / app / location

## Admin UI

The account manager is at `https://ghl-mcp.<your-subdomain>.workers.dev/admin`.

- Protected by Cloudflare Access. You must sign in with your Zero Trust identity before the page loads.
- Manage multiple GHL sub-accounts: add, delete, and set the active account.
- API keys are encrypted (AES-256-GCM) before being stored in D1.
- Account API calls also require your `MCP_AUTH_TOKEN`, entered in the page's token prompt and kept in sessionStorage for that browser tab only.

## Project structure

```
├── src/
│   ├── index.js      # Worker entry point & request router
│   ├── auth.js       # MCP bearer token middleware
│   ├── access.js     # Cloudflare Access JWT validation (admin route)
│   ├── admin.js      # Admin UI HTML + /api/accounts REST handlers
│   ├── crypto.js     # AES-256-GCM encryption for stored API keys
│   ├── db.js         # D1 account CRUD helpers
│   ├── ghl.js        # GHL API proxy layer
│   ├── mcp.js        # MCP protocol handler (JSON-RPC 2.0)
│   ├── oauth.js      # OAuth 2.0 endpoints + redirect allowlist
│   └── tools.js      # Tool definitions & argument validation
├── test/
│   ├── access.test.js       # Cloudflare Access JWT tests
│   ├── admin.test.js        # Admin UI & accounts API tests
│   ├── auth.test.js         # Auth middleware tests
│   ├── crypto.test.js       # Encryption/decryption tests
│   ├── db.test.js           # D1 CRUD tests
│   ├── ghl.test.js          # GHL proxy tests (mocked fetch)
│   ├── mcp.test.js          # MCP handler tests
│   ├── oauth.test.js        # OAuth endpoint & redirect allowlist tests
│   ├── tools.test.js        # Tool schema & validation tests
│   └── integration.test.js  # Full Worker integration tests
├── .dev.vars.example
├── schema.sql
├── wrangler.toml
├── vitest.config.js
└── package.json
```
