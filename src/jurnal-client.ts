import { createHmac } from 'crypto';

const BASE_URL = 'https://api.jurnal.id';

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.JURNAL_CLIENT_ID;
  const clientSecret = process.env.JURNAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('JURNAL_CLIENT_ID and JURNAL_CLIENT_SECRET environment variables are required');
  }
  return { clientId, clientSecret };
}

function buildAuthHeaders(method: string, path: string): { Date: string; Authorization: string } {
  const { clientId, clientSecret } = getCredentials();
  const dateString = new Date().toUTCString();
  const requestLine = `${method.toUpperCase()} ${path} HTTP/1.1`;
  const signingString = `date: ${dateString}\n${requestLine}`;
  const signature = createHmac('sha256', clientSecret)
    .update(signingString)
    .digest('base64');
  const authorization = `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
  return { Date: dateString, Authorization: authorization };
}

export async function jurnalRequest<T = unknown>(
  method: string,
  path: string,
  params?: Record<string, string | number | boolean>,
  body?: unknown
): Promise<T> {
  let fullPath = path;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString();
    fullPath = `${path}?${qs}`;
  }

  const headers = buildAuthHeaders(method, fullPath);
  const requestHeaders: Record<string, string> = {
    'Date': headers.Date,
    'Authorization': headers.Authorization,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const url = `${BASE_URL}${fullPath}`;
  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers: requestHeaders,
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    let errorMessage = `Jurnal API error: ${response.status} ${response.statusText}`;
    try {
      const errorBody = await response.json() as { message?: string; errors?: unknown };
      if (errorBody.message) {
        errorMessage = `Jurnal API error: ${errorBody.message}`;
      } else if (errorBody.errors) {
        errorMessage = `Jurnal API error: ${JSON.stringify(errorBody.errors)}`;
      }
    } catch {
      // ignore JSON parse error, use default message
    }
    throw new Error(errorMessage);
  }

  return response.json() as Promise<T>;
}
