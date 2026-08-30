import crypto from 'node:crypto';
import type { Request } from 'express';

const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const ACCESS_TOKEN_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MS ?? 60 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
const OAUTH_DEBUG = process.env.OAUTH_DEBUG === '1' || process.env.DEBUG_OAUTH === '1';

type Client = { clientId: string; redirectUris: string[]; clientName?: string };
type Code = { clientId: string; redirectUri: string; codeChallenge?: string; expiresAt: number };
type Refresh = { clientId: string; expiresAt: number };

const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
const accessTokens = new Map<string, { clientId: string; expiresAt: number }>();
const refreshTokens = new Map<string, Refresh>();

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const short = (value: unknown) => typeof value === 'string' ? `${value.slice(0, 12)}${value.length > 12 ? '…' : ''}` : value;
function oauthDebug(event: string, details: Record<string, unknown> = {}) {
  if (!OAUTH_DEBUG) return;
  console.log(`[oauth] ${event} ${JSON.stringify(details)}`);
}

export function oauthMetadata() {
  const metadata = {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
  oauthDebug('metadata', { issuer: metadata.issuer });
  return metadata;
}

export function protectedResourceMetadata() {
  const metadata = {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
  oauthDebug('protected-resource-metadata', { resource: metadata.resource });
  return metadata;
}

export function registerClient(body: any) {
  oauthDebug('register:start', {
    clientName: body?.client_name,
    redirectUris: Array.isArray(body?.redirect_uris) ? body.redirect_uris : undefined,
  });
  if (!Array.isArray(body?.redirect_uris) || body.redirect_uris.length === 0) throw new Error('redirect_uris is required');
  for (const uri of body.redirect_uris) {
    if (typeof uri !== 'string' || !/^https?:\/\//.test(uri)) throw new Error('redirect_uris must contain http(s) URLs');
  }
  const clientId = random(24);
  clients.set(clientId, { clientId, redirectUris: body.redirect_uris, clientName: body.client_name });
  oauthDebug('register:success', { clientId: short(clientId), redirectUriCount: body.redirect_uris.length });
  return { client_id: clientId, client_name: body.client_name ?? 'MCP Client', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' };
}

export function authorizationPage(req: Request) {
  const clientId = String(req.query.client_id ?? '');
  const redirectUri = String(req.query.redirect_uri ?? '');
  const state = String(req.query.state ?? '');
  const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
  const responseType = String(req.query.response_type ?? '');
  const client = clients.get(clientId);
  oauthDebug('authorize:start', {
    clientId: short(clientId),
    redirectUri,
    responseType,
    hasState: Boolean(state),
    hasCodeChallenge: Boolean(codeChallenge),
    codeChallengeMethod: req.query.code_challenge_method,
    clientFound: Boolean(client),
    redirectUriAllowed: Boolean(client?.redirectUris.includes(redirectUri)),
  });
  if (!client || responseType !== 'code' || !client.redirectUris.includes(redirectUri)) {
    oauthDebug('authorize:rejected', { clientId: short(clientId), responseType, redirectUri });
    return { status: 400, body: 'Invalid OAuth authorization request.' };
  }
  const action = `/oauth/authorize/approve?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge ?? '')}`;
  oauthDebug('authorize:page', { clientId: short(clientId), redirectUri });
  return {
    status: 200,
    body: `<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:60px auto"><h2>Authorize Windows MCP</h2><p>${html(client.clientName ?? 'An MCP client')} requests access to your Windows computer through <b>${html(PUBLIC_URL)}</b>.</p><ul><li>Read and write files within configured directories</li><li>Inspect connected Windows agents</li><li>Execute PowerShell only if enabled by the agent policy</li></ul><form method="post" action="${action}"><button style="padding:10px 18px">Authorize</button></form></body></html>`,
  };
}

export function approve(req: Request) {
  const { client_id, redirect_uri, state, code_challenge } = req.query as Record<string, string>;
  const client = clients.get(client_id);
  oauthDebug('authorize:approve:start', {
    clientId: short(client_id),
    redirectUri: redirect_uri,
    hasState: Boolean(state),
    hasCodeChallenge: Boolean(code_challenge),
    clientFound: Boolean(client),
    redirectUriAllowed: Boolean(client?.redirectUris.includes(redirect_uri)),
  });
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    oauthDebug('authorize:approve:rejected', { clientId: short(client_id), redirectUri: redirect_uri });
    return { status: 400, body: 'Invalid OAuth authorization request.' };
  }
  const code = random();
  codes.set(code, { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge || undefined, expiresAt: Date.now() + 5 * 60 * 1000 });
  const target = new URL(redirect_uri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  oauthDebug('authorize:approve:success', { clientId: short(client_id), redirectUri: redirect_uri, code: short(code), redirectTarget: target.origin + target.pathname, hasState: Boolean(state) });
  return { status: 302, location: target.toString() };
}

function verifyPkce(verifier: string | undefined, challenge: string | undefined) {
  if (!challenge) {
    oauthDebug('pkce:skip', { reason: 'no_challenge' });
    return true;
  }
  if (!verifier) {
    oauthDebug('pkce:failed', { reason: 'missing_verifier' });
    return false;
  }
  const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (actual.length !== challenge.length) {
    oauthDebug('pkce:failed', { reason: 'length_mismatch', actualLength: actual.length, challengeLength: challenge.length });
    return false;
  }
  const valid = crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
  oauthDebug('pkce:verified', { valid });
  return valid;
}

export function exchangeToken(body: any) {
  const grantType = body?.grant_type;
  oauthDebug('token:start', {
    grantType,
    clientId: short(body?.client_id),
    redirectUri: body?.redirect_uri,
    hasCode: Boolean(body?.code),
    hasCodeVerifier: Boolean(body?.code_verifier),
    hasRefreshToken: Boolean(body?.refresh_token),
  });
  if (grantType === 'authorization_code') {
    const item = codes.get(body.code);
    oauthDebug('token:authorization-code:lookup', {
      found: Boolean(item),
      expired: Boolean(item && item.expiresAt < Date.now()),
      storedClientId: short(item?.clientId),
      requestedClientId: short(body?.client_id),
      redirectUriMatch: Boolean(item && item.redirectUri === body?.redirect_uri),
      hasCodeChallenge: Boolean(item?.codeChallenge),
    });
    if (!item || item.expiresAt < Date.now()) throw new Error('invalid_grant');
    codes.delete(body.code);
    if (item.clientId !== body.client_id || item.redirectUri !== body.redirect_uri || !verifyPkce(body.code_verifier, item.codeChallenge)) {
      oauthDebug('token:authorization-code:rejected', {
        clientIdMatch: item.clientId === body.client_id,
        redirectUriMatch: item.redirectUri === body.redirect_uri,
      });
      throw new Error('invalid_grant');
    }
    const tokens = issueTokens(item.clientId);
    oauthDebug('token:authorization-code:success', { clientId: short(item.clientId) });
    return tokens;
  }
  if (grantType === 'refresh_token') {
    const item = refreshTokens.get(body.refresh_token);
    oauthDebug('token:refresh:lookup', {
      found: Boolean(item),
      expired: Boolean(item && item.expiresAt < Date.now()),
      clientIdMatch: Boolean(item && item.clientId === body?.client_id),
    });
    if (!item || item.expiresAt < Date.now() || item.clientId !== body.client_id) throw new Error('invalid_grant');
    refreshTokens.delete(body.refresh_token);
    const tokens = issueTokens(item.clientId);
    oauthDebug('token:refresh:success', { clientId: short(item.clientId) });
    return tokens;
  }
  oauthDebug('token:rejected', { reason: 'unsupported_grant_type', grantType });
  throw new Error('unsupported_grant_type');
}

function issueTokens(clientId: string) {
  const access = random();
  const refresh = random();
  accessTokens.set(access, { clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
  refreshTokens.set(refresh, { clientId, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  oauthDebug('tokens:issued', { clientId: short(clientId), accessToken: short(access), refreshToken: short(refresh), accessExpiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) });
  return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: 'mcp' };
}

export function validAccessToken(token: string | undefined) {
  if (!token) {
    oauthDebug('access-token:missing');
    return false;
  }
  const item = accessTokens.get(token);
  if (!item) {
    oauthDebug('access-token:invalid', { token: short(token) });
    return false;
  }
  if (item.expiresAt < Date.now()) {
    accessTokens.delete(token);
    oauthDebug('access-token:expired', { clientId: short(item.clientId), token: short(token) });
    return false;
  }
  oauthDebug('access-token:valid', { clientId: short(item.clientId), token: short(token) });
  return true;
}
