import { cdpCall, cdpListTargets, cdpVersion } from './cdp.js';
export async function runBrowserTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'cdp_version': return cdpVersion();
    case 'cdp_list_targets': return cdpListTargets();
    case 'cdp_call': return cdpCall(args);
    default: throw new Error(`Unsupported browser tool: ${tool}`);
  }
}
