import { BridgeHandler, BridgeMessage } from '../types';
import { BridgeContext } from '../types';

export class SessionHandler implements BridgeHandler {
  readonly supportedEvents = [
    'send_message',
    'send_message_with_attachments',
    'preconnect',
    'abort',
    'reset_runtime',
    'heartbeat',
    'interrupt_session',
    'restart_session',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'interrupt_session':
        this.context.callbacks.sendToBridge('abort', content, webview);
        return true;
      case 'restart_session':
        this.context.callbacks.sendToBridge('reset_runtime', content, webview);
        return true;
      default:
        this.context.callbacks.sendToBridge(event, content, webview);
        return true;
    }
  }
}
