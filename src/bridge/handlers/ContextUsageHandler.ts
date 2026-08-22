import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';

export class ContextUsageHandler implements BridgeHandler {
  readonly supportedEvents = ['get_context_usage'] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    if (event !== 'get_context_usage') return false;
    this.context.callbacks.sendToBridge(event, content, webview);
    return true;
  }
}
