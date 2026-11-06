export type ProxyInfo = {
  configured: boolean;
  proxies: { http: string | null; https: string | null; all: string | null };
  noProxy: string | null;
};

function safeProxyUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/u, parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : '/');
  } catch {
    return '[configured; unable to parse proxy URL]';
  }
}

export function getProxyInfo(env: NodeJS.ProcessEnv = process.env): ProxyInfo {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value) values.set(key.toLowerCase(), value);
  }
  const http = safeProxyUrl(values.get('http_proxy'));
  const https = safeProxyUrl(values.get('https_proxy'));
  const all = safeProxyUrl(values.get('all_proxy'));
  const noProxy = values.get('no_proxy')?.trim() || null;
  return { configured: Boolean(http || https || all), proxies: { http, https, all }, noProxy };
}
