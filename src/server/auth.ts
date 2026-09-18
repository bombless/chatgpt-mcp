import crypto from 'node:crypto';

/**
 * Authentication helpers for the public MCP resource.
 *
 * OAuth access tokens use the standard `Authorization: Bearer ...` header.
 * A deployment may also configure a static MCP API key.  API keys are
 * accepted through the conventional `X-MCP-API-Key`/`X-API-Key` headers or
 * `Authorization: ApiKey ...`; a configured key is also accepted as a Bearer
 * credential for clients that only expose a bearer-token field.
 */

export type HeaderSource = { header(name: string): string | undefined };

export type AuthCredentials = {
  scheme?: string;
  bearerToken?: string;
  apiKey?: string;
};

const API_KEY_HEADERS = ['x-mcp-api-key', 'x-api-key', 'x-goog-api-key'] as const;

export function authCredentials(req: HeaderSource): AuthCredentials {
  const apiKey = API_KEY_HEADERS.map(name => req.header(name)?.trim()).find(value => Boolean(value));
  const authorization = req.header('authorization')?.trim();
  if (authorization) {
    const match = /^([^\s]+)\s+(.+)$/.exec(authorization);
    if (match) {
      const scheme = match[1];
      const credential = match[2].trim();
      if (credential) {
        if (scheme.toLowerCase() === 'bearer') return { scheme, bearerToken: credential, ...(apiKey ? { apiKey } : {}) };
        if (scheme.toLowerCase() === 'apikey') return { scheme, apiKey: credential };
      }
      // Keep the API-key header when a client sent an unsupported or malformed
      // Authorization value alongside its key.
      return { scheme, ...(apiKey ? { apiKey } : {}) };
    }
    return { scheme: authorization, ...(apiKey ? { apiKey } : {}) };
  }

  if (apiKey) {
    const scheme = API_KEY_HEADERS.find(name => req.header(name)?.trim() === apiKey);
    return { scheme, apiKey };
  }
  return {};
}

/** Compare secrets without leaking an early-exit timing signal. */
export function secretMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
