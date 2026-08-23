import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { resolveClaudePlanUsagePayload } from '../services/claudePlanUsageService';

/**
 * Bridges the webview's `get_claude_plan_usage` poll to the cached SDK
 * rate_limit_event snapshot and pushes the result back via
 * `window.updateClaudePlanUsage`. Mirrors the JetBrains ClaudePlanUsageHandler;
 * the reply goes only to the polling webview (request-scoped routing).
 */
export class ClaudePlanUsageHandler implements BridgeHandler {
  readonly supportedEvents = ['get_claude_plan_usage'] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, webview }: BridgeMessage): boolean {
    if (event !== 'get_claude_plan_usage') {
      return false;
    }
    let payload: Record<string, unknown>;
    try {
      payload = resolveClaudePlanUsagePayload();
    } catch (err) {
      payload = { error: true, message: err instanceof Error ? err.message : String(err) };
    }
    webview.postMessage({
      type: 'js_eval',
      content: `window.updateClaudePlanUsage && window.updateClaudePlanUsage(${JSON.stringify(JSON.stringify(payload))})`,
    });
    return true;
  }
}
