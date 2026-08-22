import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';

export class UsageStatisticsHandler implements BridgeHandler {
  readonly supportedEvents = ['get_usage_statistics'] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    if (event !== 'get_usage_statistics') {
      return false;
    }
    this.context.callbacks.getUsageStatistics(content, webview);
    return true;
  }
}
