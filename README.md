# GHL MCP Server

A custom MCP (Model Context Protocol) server that wraps the GoHighLevel v2 REST API, deployed to Cloudflare Workers. Gives Claude full, reliable access to one or more GHL sub-accounts via natural language.

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

The `locationId` is always injected server-side from the active account — Claude never needs to pass it.

## Security

- **Layer 1 — MCP Bearer Token:** Every `/mcp` and `/api/accounts/*` request must include `Authorization: Bearer <MCP_AUTH_TOKEN>`. Validated with a constant-time comparison to prevent timing attacks.
- **Layer 2 — Cloudflare Access:** The `/admin` page is gated by Cloudflare Access. Only users in your Zero Trust policy can load the page. The Worker additionally validates the `Cf-Access-Jwt-Assertion` JWT (RS256, audience-checked) to prevent direct bypasses.
- **Layer 3 — GHL Credentials:** `GHL_API_KEY` / `GHL_LOCATION_ID` (legacy) and per-account keys stored in D1 are Cloudflare secrets or AES-256-GCM encrypted at rest — never in source code, logs, or API responses.
- **Path sanitization:** Strips `../` traversal sequences and rejects shell-special characters.
- **Body size limit:** Requests exceeding 1 MB are rejected before they reach the GHL API.
- **No stack traces:** Error responses return only a safe message string, never internal state.
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Cache-Control: no-store` on every response.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set Cloudflare secrets

```bash
# Generate a secure token for MCP/API auth
openssl rand -hex 32

wrangler secret put GHL_API_KEY       # GHL sub-account private integration key (legacy / default)
wrangler secret put GHL_LOCATION_ID  # GHL sub-account location ID (legacy / default)
wrangler secret put MCP_AUTH_TOKEN   # Bearer token you just generated
wrangler secret put MASTER_KEY       # Encryption key for per-account API keys stored in D1
```

**Getting GHL credentials:**
- Go to your sub-account → Settings → Integrations → Private Integrations
- Create a new integration and copy the API key
- The location ID is in the sub-account URL or under Settings → Business Profile

**Generating MASTER_KEY:**
```bash
openssl rand -hex 32
```

### 3. Create the D1 database

```bash
wrangler d1 create ghl-mcp-accounts
```

Copy the `database_id` from the output into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ghl-mcp-accounts"
database_id = "<your-database-id>"
```

Apply the schema:

```bash
wrangler d1 execute ghl-mcp-accounts --file=schema.sql
```

### 4. Configure Cloudflare Access (admin UI protection)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → your account → **Zero Trust**
2. **Access → Applications → Add an application → Self-hosted**
   - Application domain: `ghl-mcp.<your-subdomain>.workers.dev`
   - Path: `admin`
3. Create a policy (Action: **Allow**, Selector: **Emails** → your email)
4. Note the **Application Audience (AUD) Tag** from the application settings

Update `src/access.js` with your values:
```js
const CERTS_URL = 'https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs';
const AUD = '<your-aud-tag>';
```

### 5. Run tests

```bash
npm test
```

### 6. Local dev server

```bash
# Copy .dev.vars.example and fill in your values
cp .dev.vars.example .dev.vars
npm run dev
```

Smoke test:
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer your_mcp_auth_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

> **Note:** Cloudflare Access JWT validation is skipped in local dev (no `Cf-Access-Jwt-Assertion` header is present), so `/admin` is accessible without authentication locally.

### 7. Deploy

```bash
npm run deploy
```

### 8. Connect Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop. The 5 GHL tools will appear automatically.

## Admin UI

The account manager is available at `https://ghl-mcp.<your-subdomain>.workers.dev/admin`.

- Protected by Cloudflare Access — you must authenticate with your Zero Trust identity before the page loads
- Manage multiple GHL sub-accounts: add, delete, and set the active account
- API keys are encrypted (AES-256-GCM) before being stored in D1
- All account API calls also require your `MCP_AUTH_TOKEN` bearer token (entered in the page's token prompt)

## GHL API Coverage

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

### Confirmed API Gaps (not available via API)

- Workflow builder (cannot create/edit workflow steps)
- Funnel/website page content editing
- Email builder editor data retrieval
- Courses/memberships
- Full reporting dashboards
- Pipeline/stage creation

## Rate Limits

- Burst: 100 requests / 10 seconds / app / location
- Daily: 200,000 requests / day / app / location

## Project Structure

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
│   ├── oauth.js      # OAuth 2.0 endpoints
│   └── tools.js      # Tool definitions & argument validation
├── test/
│   ├── auth.test.js         # Auth middleware tests
│   ├── admin.test.js        # Admin UI & accounts API tests
│   ├── crypto.test.js       # Encryption/decryption tests
│   ├── db.test.js           # D1 CRUD tests
│   ├── ghl.test.js          # GHL proxy tests (mocked fetch)
│   ├── mcp.test.js          # MCP handler tests
│   ├── tools.test.js        # Tool schema & validation tests
│   └── integration.test.js  # Full Worker integration tests
├── schema.sql
├── wrangler.toml
├── vitest.config.js
└── package.json
```
