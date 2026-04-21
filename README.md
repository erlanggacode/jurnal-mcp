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

## Connecting to Claude.ai or n8n

- **MCP server URL**: `http://your-host:3000/mcp`
- **Transport**: Streamable HTTP
- **No authentication required** at the MCP level (Jurnal auth is handled internally)

The server binds to `0.0.0.0:3000` and is accessible from any machine on the same network.
To find your server's IP: `hostname -I`

To add to Claude Code:
```bash
claude mcp add jurnal-mcp --transport http http://your-host:3000/mcp
```

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
