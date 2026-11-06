import crypto from 'node:crypto';
import express from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import {
  approve,
  authorizationPage,
  exchangeToken,
  getBaseUrl,
  oauthMetadata,
  protectedResourceMetadata,
  registerClient,
  validAccessToken,
} from './oauth.js';

export interface McpAppRegistry {
  list(): unknown[];
}

export interface McpAppOptions {
  registry: McpAppRegistry;
  buildMcpServer: () => McpServer;
  legacyMcpToken?: string;
  mcpDebug?: (event: string, details?: Record<string, unknown>) => void;
}

export function createMcpApp({ registry, buildMcpServer, legacyMcpToken, mcpDebug = () => {} }: McpAppOptions) {
  function requestId(req: express.Request) { return req.get('x-request-id') ?? crypto.randomUUID(); }
  function safeAuthInfo(req: express.Request) {
    const authorization = req.header('authorization');
    return { hasAuthorization: Boolean(authorization), scheme: authorization?.split(/\s+/, 1)[0], tokenLength: authorization?.startsWith('Bearer ') ? authorization.slice(7).length : undefined };
  }
  function bearer(req: express.Request) {
    const value = req.header('authorization');
    return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
  }
  async function mcpAuthorized(req: express.Request) {
    const token = bearer(req);
    const oauthValid = await validAccessToken(token);
    const legacyValid = !!legacyMcpToken && token === legacyMcpToken;
    mcpDebug('authorization:check', { ...safeAuthInfo(req), oauthValid, legacyValid });
    return oauthValid || legacyValid;
  }
  function mcpUnauthorized(res: express.Response, req?: express.Request) {
    if (req) mcpDebug('authorization:rejected', safeAuthInfo(req));
    const baseUrl = getBaseUrl(req);
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' });
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((req, res, next) => {
    const id = requestId(req);
    res.setHeader('X-Request-Id', id);
    mcpDebug('http:request', { requestId: id, method: req.method, path: req.path, query: req.query, contentType: req.get('content-type'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined, ...safeAuthInfo(req) });
    res.on('finish', () => {
      mcpDebug('http:response', { requestId: id, method: req.method, path: req.path, status: res.statusCode });
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauthMetadata(getBaseUrl(req))));
  app.get('/.well-known/openid-configuration', (req, res) => res.json(oauthMetadata(getBaseUrl(req))));
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(protectedResourceMetadata(getBaseUrl(req))));
  app.get('/.well-known/oauth-protected-resource/*subpath', (req, res) => res.json(protectedResourceMetadata(getBaseUrl(req))));
  app.post('/oauth/register', async (req, res) => { try { res.status(201).json(await registerClient(req.body)); } catch (e) { res.status(400).json({ error: 'invalid_client_metadata', error_description: String(e instanceof Error ? e.message : e) }); } });
  app.get('/oauth/authorize', async (req, res) => { const result = await authorizationPage(req); res.status(result.status).type('html').send(result.body); });
  app.post('/oauth/authorize/approve', async (req, res) => { const result = await approve(req); if (result.location) return res.redirect(302, result.location); return res.status(result.status).send(result.body); });
  app.post('/oauth/token', async (req, res) => { try { res.json(await exchangeToken(req.body)); } catch (e) { const error = String(e instanceof Error ? e.message : e); res.status(400).json({ error }); } });
  app.get('/agents', async (req, res) => { if (!await mcpAuthorized(req)) return mcpUnauthorized(res, req); res.json({ agents: registry.list() }); });

  const mcpHandler = toNodeHandler(createMcpHandler(buildMcpServer));
  app.all('/mcp', async (req, res) => {
    if (!await mcpAuthorized(req)) return mcpUnauthorized(res, req);
    mcpDebug('handler:dispatch', { method: req.method, contentType: req.get('content-type'), accept: req.get('accept'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined });
    try {
      const result = mcpHandler(req, res, req.body);
      if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).then(() => mcpDebug('handler:complete', { method: req.method })).catch(error => mcpDebug('handler:error', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }));
    } catch (error) { mcpDebug('handler:throw', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }); throw error; }
  });

  return app;
}
