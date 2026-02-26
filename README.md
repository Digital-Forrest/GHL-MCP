# GHL MCP Server

A custom MCP (Model Context Protocol) server that wraps the GoHighLevel v2 REST API, deployed to Cloudflare Workers. Gives Claude full, reliable access to a GHL sub-account via natural language.

## Architecture

```
Claude (MCP Client)
       │
       ▼
[Bearer Token Auth]
Cloudflare Worker — POST /mcp  (JSON-RPC 2.0)
       │
       ▼
[GHL_API_KEY + GHL_LOCATION_ID injected automatically]
https://services.leadconnectorhq.com  (GHL v2 API)
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

The `locationId` is always injected server-side — Claude never needs to pass it.

## Security

- **Layer 1 — MCP Bearer Token:** Every incoming request must include `Authorization: Bearer <MCP_AUTH_TOKEN>`. Validated with a constant-time comparison to prevent timing attacks.
- **Layer 2 — GHL Credentials:** `GHL_API_KEY` and `GHL_LOCATION_ID` are Cloudflare secrets — never in source code, logs, or API responses.
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
# Generate a secure token
openssl rand -hex 32

wrangler secret put GHL_API_KEY       # GHL sub-account private integration key
wrangler secret put GHL_LOCATION_ID  # GHL sub-account location ID 
wrangler secret put MCP_AUTH_TOKEN   # Bearer token you just generated
```

**Getting GHL credentials:**
- Go to your sub-account → Settings → Integrations → Private Integrations
- Create a new integration and copy the API key
- The location ID is in the sub-account URL or under Settings → Business Profile

### 3. Run tests

```bash
npm test
```

### 4. Local dev server

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

### 5. Deploy

```bash
npm run deploy
```

### 6. Connect Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ghl-mcp": {
      "url": "https://ghl-mcp.digital-forrest.workers.dev/mcp",
      "headers": {
        "Authorization": "32530f0d09225b4c9e4ff542f9efdc3c6fb0aa2873707ee8753acffbb4e160f"
      }
    }
  }
}
```

Restart Claude Desktop. The 5 GHL tools will appear automatically.

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
│   ├── auth.js       # Bearer token middleware
│   ├── ghl.js        # GHL API proxy layer
│   ├── mcp.js        # MCP protocol handler (JSON-RPC 2.0)
│   └── tools.js      # Tool definitions & argument validation
├── test/
│   ├── auth.test.js         # Auth middleware tests
│   ├── ghl.test.js          # GHL proxy tests (mocked fetch)
│   ├── mcp.test.js          # MCP handler tests
│   ├── tools.test.js        # Tool schema & validation tests
│   └── integration.test.js # Full Worker integration tests
├── wrangler.toml
├── vitest.config.js
└── package.json
```
