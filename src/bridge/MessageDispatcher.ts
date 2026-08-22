import { BridgeHandler, BridgeMessage } from './types';

export class MessageDispatcher {
  private readonly handlers: BridgeHandler[] = [];

  register(handler: BridgeHandler): void {
    this.handlers.push(handler);
  }

  async dispatch(message: BridgeMessage): Promise<boolean> {
    for (const handler of this.handlers) {
      if (!handler.supportedEvents.includes(message.event)) {
        continue;
      }
      if (await handler.handle(message)) {
        return true;
      }
    }
    return false;
  }

  hasHandlerFor(event: string): boolean {
    return this.handlers.some((handler) => handler.supportedEvents.includes(event));
  }

  getHandlerCount(): number {
    return this.handlers.length;
  }
}
