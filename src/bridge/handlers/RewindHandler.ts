import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';

export class RewindHandler implements BridgeHandler {
  readonly supportedEvents = ['rewind_files'] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    if (event !== 'rewind_files') return false;
    this.context.callbacks.sendToBridge(event, content, webview);
    return true;
  }
}
