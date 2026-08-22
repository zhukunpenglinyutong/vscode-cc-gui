import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
export class HistoryHandler implements BridgeHandler {
  readonly supportedEvents = [
    'load_history_data',
    'load_session',
    'delete_session',
    'delete_history_session',
    'delete_sessions',
    'export_session',
    'toggle_favorite',
    'toggle_favorite_session',
    'update_title',
    'update_history_title',
    'delete_title',
    'deep_search_history',
    'load_subagent_session',
    'convert_to_cli_session',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'load_history_data':
        this.context.callbacks.loadHistoryData(content, webview);
        return true;
      case 'deep_search_history':
        this.context.callbacks.deepSearchHistory(content, webview);
        return true;
      case 'load_session':
        this.context.callbacks.loadSession(
          this.extractSessionId(content),
          this.extractProvider(content),
          webview,
        );
        return true;
      case 'delete_session':
      case 'delete_history_session':
        this.context.callbacks.deleteHistorySession(content, webview);
        return true;
      case 'delete_sessions':
        this.context.callbacks.deleteHistorySessions(content, webview);
        return true;
      case 'export_session':
        this.context.callbacks.exportHistorySession(content, webview);
        return true;
      case 'update_title':
      case 'update_history_title':
        this.context.callbacks.updateHistoryTitle(content, webview);
        return true;
      case 'delete_title':
        this.context.callbacks.deleteHistoryTitle(content, webview);
        return true;
      case 'toggle_favorite':
      case 'toggle_favorite_session':
        this.context.callbacks.toggleFavoriteSession(content, webview);
        return true;
      case 'load_subagent_session':
        this.context.callbacks.loadSubagentSession(content, webview);
        return true;
      case 'convert_to_cli_session':
        this.context.callbacks.convertToCliSession(content, webview);
        return true;
      default:
        return false;
    }
  }

  private extractSessionId(content: string): string {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return trimmed;
    try {
      const payload = JSON.parse(trimmed);
      if (typeof payload?.sessionId === 'string') return payload.sessionId.trim();
      if (typeof payload?.id === 'string') return payload.id.trim();
    } catch {
      // Fall back to the legacy raw content path below.
    }
    return trimmed;
  }

  private extractProvider(content: string): string | undefined {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      const payload = JSON.parse(trimmed);
      return typeof payload?.provider === 'string' ? payload.provider.trim() : undefined;
    } catch {
      return undefined;
    }
  }
}
