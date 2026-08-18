# jurnal-mcp

MCP server that wraps the Jurnal.id REST API, deployable as a Docker container.

## Prerequisites

- Docker installed

## Configuration

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```
JURNAL_CLIENT_ID=your_client_id_here
JURNAL_CLIENT_SECRET=your_client_secret_here
MCP_PORT=3000
```

## Running with Docker

```bash
# Build the image
docker build -t jurnal-mcp .

# Run the container
docker run -d \
  --name jurnal-mcp \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  jurnal-mcp
```

### Useful commands

```bash
docker logs jurnal-mcp        # view logs
docker logs -f jurnal-mcp     # follow logs live
docker restart jurnal-mcp     # restart
docker stop jurnal-mcp        # stop
docker rm jurnal-mcp          # remove container
```

## Running with Docker Compose

```bash
docker-compose up --build -d
```

## Running locally without Docker

```bash
npm install
npm run build
npm start
```

## Connecting to Claude Code or n8n

- **MCP server URL**: `http://your-host:3000/mcp`
- **Transport**: Streamable HTTP
- **Auth**: `Authorization: Bearer <MCP_API_KEY>` header, if `MCP_API_KEY` is set (recommended for
  anything reachable outside your own machine)

The server binds to `0.0.0.0:3000` and is accessible from any machine on the same network.
To find your server's IP: `hostname -I`

To add to Claude Code:
```bash
claude mcp add --transport http jurnal-mcp http://your-host:3000/mcp --header "Authorization: Bearer <MCP_API_KEY>"
```

## Connecting to claude.ai / Cowork (custom connector)

claude.ai's custom connector UI only accepts OAuth Client ID/Secret, not a raw bearer token, so
the server also implements a minimal OAuth 2.1 authorization server (dynamic client
registration + PKCE authorization code + refresh tokens) purely to satisfy that flow. There is
no separate account system — the "consent screen" at `/authorize` just asks for the same
`MCP_API_KEY`.

The server must be reachable over the public internet (Anthropic's cloud connects to it, not
your local network) — e.g. via a Tailscale Funnel URL or another public HTTPS reverse proxy.

1. In claude.ai: **Customize > Connectors > Add custom connector**
2. Remote MCP server URL: `https://your-public-host/mcp`
3. Leave OAuth Client ID/Secret blank — the server registers a client automatically via DCR
4. Click through the `/authorize` prompt and enter your `MCP_API_KEY` when asked

OAuth client/token state is in-memory and does not survive a redeploy of the container; if a
connection stops working after a deploy, remove and re-add the connector (or wait for Claude's
automatic reactive reconnect on the next 401).

## Available Tools

| Tool | Description |
|------|-------------|
| `list_sales_orders` | List sales orders with optional status filter (open/closed/all) |
| `get_sales_order` | Get full details of a sales order including line items |
| `close_sales_order` | Close an open sales order |
| `create_sales_order` | Create a new sales order with customer and line items |
| `create_delivery_order` | Create a delivery order from an existing sales order |
| `list_sales_invoices` | List sales invoices |
| `list_receive_payments` | List received payments |
| `get_receive_payments_by_invoice` | Get all payments for a specific invoice with total paid |
| `create_receive_payment` | Record a new payment received against an invoice |
