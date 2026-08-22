import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';

export class WindowEventHandler implements BridgeHandler {
  readonly supportedEvents = [
    'frontend_ready',
    'create_new_session',
    'create_new_tab',
    'tab_loading_changed',
    'tab_status_changed',
    'refresh_slash_commands',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'frontend_ready':
        this.context.callbacks.frontendReady(webview);
        return true;
      case 'create_new_session':
        this.context.callbacks.createNewSession(webview);
        return true;
      case 'create_new_tab':
        this.context.callbacks.createNewTab(webview);
        return true;
      case 'tab_loading_changed':
        this.context.callbacks.tabLoadingChanged(content);
        return true;
      case 'tab_status_changed':
        this.context.callbacks.tabStatusChanged(content);
        return true;
      case 'refresh_slash_commands':
        this.context.callbacks.refreshSlashCommands(webview);
        return true;
      default:
        return false;
    }
  }
}
