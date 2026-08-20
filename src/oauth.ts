import { randomUUID, randomBytes, createHash } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

/**
 * Minimal OAuth 2.1 authorization server (RFC 8414 metadata, RFC 7591 dynamic client
 * registration, PKCE-only authorization code + refresh token grants) so claude.ai / Cowork
 * custom connectors can authenticate. Their connector UI only offers OAuth Client ID/Secret —
 * there is no plain bearer-token field for the general public — so this exists purely to let
 * Claude's hosted OAuth client obtain a token; the "consent screen" is a password gate on the
 * existing MCP_API_KEY, since there is only one real user of this server.
 *
 * State is in-memory and does not survive a redeploy — an existing claude.ai connection will
 * need to reauthorize (Claude refreshes reactively on 401, so this is a one-time reconnect,
 * not a broken integration).
 */

interface Client {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expiresAt: number;
}

interface TokenEntry {
  client_id: string;
  scope: string;
  expiresAt: number;
}

const clients = new Map<string, Client>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, TokenEntry>();
const refreshTokens = new Map<string, TokenEntry>();

/**
 * A fixed client_id for manual configuration (claude.ai's "OAuth Client ID" field), so it
 * survives redeploys. Dynamically registered clients (via POST /register) still live only in
 * memory and are lost on restart — that's fine for DCR, which re-registers automatically on
 * the next connection attempt, but a manually-typed ID has no such retry.
 */
const STATIC_CLIENT_ID = 'jurnal-mcp';
const STATIC_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback'];
clients.set(STATIC_CLIENT_ID, { client_id: STATIC_CLIENT_ID, redirect_uris: STATIC_REDIRECT_URIS, client_name: 'claude.ai (static)' });

// Generous window: the real round trip is browser redirect -> claude.ai processing ->
// claude.ai's backend calling /token, which can take much longer than a scripted exchange.
const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_TTL_S = 3600;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
}, 10 * 60 * 1000).unref();

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reverse proxies in front of this server (Tailscale Funnel included) can rewrite or strip
 * the port from the Host header before forwarding, so a URL derived from req.headers.host may
 * not match the URL the user actually entered in Claude. The OAuth spec requires the
 * protected-resource `resource` field to match that URL exactly, so an explicit
 * PUBLIC_BASE_URL takes precedence when set; req.headers.host is a best-effort fallback for
 * setups (e.g. plain LAN access) where no proxy is involved.
 */
export function baseUrl(req: IncomingMessage): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  return `${proto}://${req.headers.host}`;
}

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname === '/register' ||
    pathname === '/authorize' ||
    pathname === '/token'
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function protectedResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  json(res, 200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
}

export function authorizationServerMetadata(req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  json(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

export function registerClient(res: ServerResponse, body: string): void {
  let payload: Record<string, unknown>;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    json(res, 400, { error: 'invalid_client_metadata' });
    return;
  }

  const redirect_uris = Array.isArray(payload.redirect_uris)
    ? (payload.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];
  if (redirect_uris.length === 0) {
    json(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    return;
  }

  const client_id = randomUUID();
  const client_name = typeof payload.client_name === 'string' ? payload.client_name : undefined;
  clients.set(client_id, { client_id, redirect_uris, client_name });

  json(res, 201, {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(client_name ? { client_name } : {}),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderAuthorizeForm(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
  return `<!doctype html>
<html><head><title>Authorize jurnal-mcp</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px;color:#1a1a1a}
input[type=password]{width:100%;padding:10px;font-size:16px;box-sizing:border-box;margin:12px 0;border:1px solid #ccc;border-radius:6px}
button{width:100%;padding:10px;font-size:16px;background:#000;color:#fff;border:none;border-radius:6px;cursor:pointer}
.err{color:#b00020;font-size:14px}
</style></head>
<body>
<h2>Authorize access to jurnal-mcp</h2>
<p>Enter your MCP API key to allow this client to access your Jurnal.id data.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/authorize">
${hidden}
<input type="password" name="api_key" placeholder="MCP API key" autofocus required>
<button type="submit">Authorize</button>
</form>
</body></html>`;
}

export function authorizeGet(res: ServerResponse, query: URLSearchParams): void {
  const client_id = query.get('client_id') ?? '';
  const redirect_uri = query.get('redirect_uri') ?? '';
  const state = query.get('state') ?? '';
  const code_challenge = query.get('code_challenge') ?? '';
  const code_challenge_method = query.get('code_challenge_method') ?? '';
  const scope = query.get('scope') ?? 'mcp';
  const response_type = query.get('response_type') ?? '';

  const client = clients.get(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Unknown client_id or redirect_uri');
    return;
  }
  if (response_type !== 'code' || code_challenge_method !== 'S256' || !code_challenge) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Unsupported request: response_type=code with PKCE S256 is required');
    return;
  }

  const html = renderAuthorizeForm({ client_id, redirect_uri, state, code_challenge, code_challenge_method, scope });
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

export function authorizePost(res: ServerResponse, body: string): void {
  const form = new URLSearchParams(body);
  const client_id = form.get('client_id') ?? '';
  const redirect_uri = form.get('redirect_uri') ?? '';
  const state = form.get('state') ?? '';
  const code_challenge = form.get('code_challenge') ?? '';
  const code_challenge_method = form.get('code_challenge_method') ?? '';
  const scope = form.get('scope') ?? 'mcp';
  const api_key = form.get('api_key') ?? '';

  const client = clients.get(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Unknown client_id or redirect_uri');
    return;
  }

  const expected = process.env.MCP_API_KEY;
  if (!expected || api_key !== expected) {
    const html = renderAuthorizeForm(
      { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope },
      'Incorrect API key. Try again.'
    );
    res.writeHead(401, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  const code = base64url(randomBytes(32));
  authCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    scope,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect_uri);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid redirect_uri');
    return;
  }
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.writeHead(302, { Location: redirectUrl.toString() });
  res.end();
}

function issueTokenPair(client_id: string, scope: string): { access_token: string; refresh_token: string } {
  const access_token = base64url(randomBytes(32));
  const refresh_token = base64url(randomBytes(32));
  accessTokens.set(access_token, { client_id, scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000 });
  refreshTokens.set(refresh_token, { client_id, scope, expiresAt: Infinity });
  return { access_token, refresh_token };
}

export function token(res: ServerResponse, body: string): void {
  const form = new URLSearchParams(body);
  const grant_type = form.get('grant_type');

  if (grant_type === 'authorization_code') {
    const code = form.get('code') ?? '';
    const redirect_uri = form.get('redirect_uri') ?? '';
    const client_id = form.get('client_id') ?? '';
    const code_verifier = form.get('code_verifier') ?? '';

    const entry = authCodes.get(code);
    if (!entry) {
      console.error(`[oauth] token exchange: unknown or already-used code (client_id=${client_id})`);
      json(res, 400, { error: 'invalid_grant', error_description: 'unknown or already-used code' });
      return;
    }
    if (entry.expiresAt < Date.now()) {
      console.error(`[oauth] token exchange: code expired ${Date.now() - entry.expiresAt}ms ago (client_id=${client_id})`);
      json(res, 400, { error: 'invalid_grant', error_description: 'code expired' });
      return;
    }
    if (entry.client_id !== client_id) {
      console.error(`[oauth] token exchange: client_id mismatch — code issued to "${entry.client_id}", request sent "${client_id}"`);
      json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }
    if (entry.redirect_uri !== redirect_uri) {
      console.error(`[oauth] token exchange: redirect_uri mismatch — code issued for "${entry.redirect_uri}", request sent "${redirect_uri}"`);
      json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    const challenge = base64url(createHash('sha256').update(code_verifier).digest());
    if (challenge !== entry.code_challenge) {
      console.error(`[oauth] token exchange: PKCE mismatch — expected challenge "${entry.code_challenge}", computed "${challenge}" from verifier len=${code_verifier.length}`);
      json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
    authCodes.delete(code);

    console.error(`[oauth] token exchange: success (client_id=${client_id})`);
    const { access_token, refresh_token } = issueTokenPair(client_id, entry.scope);
    json(res, 200, {
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token,
      scope: entry.scope,
    });
    return;
  }

  if (grant_type === 'refresh_token') {
    const refresh_token = form.get('refresh_token') ?? '';
    const entry = refreshTokens.get(refresh_token);
    if (!entry) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    refreshTokens.delete(refresh_token);
    const issued = issueTokenPair(entry.client_id, entry.scope);
    json(res, 200, {
      access_token: issued.access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: issued.refresh_token,
      scope: entry.scope,
    });
    return;
  }

  json(res, 400, { error: 'unsupported_grant_type' });
}

export function validateAccessToken(accessToken: string): boolean {
  const entry = accessTokens.get(accessToken);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    accessTokens.delete(accessToken);
    return false;
  }
  return true;
}
