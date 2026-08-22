import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';

export class ClipboardHandler implements BridgeHandler {
  readonly supportedEvents = [
    'write_clipboard',
    'read_clipboard',
    'get_active_file',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'write_clipboard':
        await this.context.callbacks.writeClipboard(content);
        return true;
      case 'read_clipboard':
        await this.context.callbacks.readClipboard(webview);
        return true;
      case 'get_active_file':
        this.context.callbacks.getActiveFile(webview);
        return true;
      default:
        return false;
    }
  }
}
