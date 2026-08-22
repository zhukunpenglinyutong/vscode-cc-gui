import { BridgeHandler, BridgeMessage } from '../types';
import { DiffService } from '../services/DiffService';

export class UndoFileHandler implements BridgeHandler {
  readonly supportedEvents = ['undo_file_changes', 'undo_all_file_changes'] as const;

  constructor(private readonly diffService: DiffService) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'undo_file_changes':
        await this.diffService.undoFileChanges(content, webview);
        return true;
      case 'undo_all_file_changes':
        await this.diffService.undoAllFileChanges(content, webview);
        return true;
      default:
        return false;
    }
  }
}
