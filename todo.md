# Todo

## Security
- [ ] Add API key middleware to MCP server (`MCP_API_KEY` env var)
  - Protect `/sse` and `/messages` endpoints with `Authorization: Bearer <key>`
  - Keep `/health` open for Docker healthcheck
