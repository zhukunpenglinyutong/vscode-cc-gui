import { BridgeHandler, BridgeMessage } from '../types';
import { DiffService } from '../services/DiffService';

export class DiffHandler implements BridgeHandler {
  readonly supportedEvents = [
    'show_diff',
    'show_editable_diff',
    'show_interactive_diff',
    'show_multi_edit_diff',
    'show_edit_preview_diff',
    'show_edit_full_diff',
  ] as const;

  constructor(private readonly diffService: DiffService) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'show_diff':
        await this.diffService.showDiff(content);
        return true;
      case 'show_editable_diff':
        // Edit panel "diff" button: compare before/after AI change (not Apply/Reject dialog).
        await this.diffService.showFileChangeDiff(content);
        return true;
      case 'show_interactive_diff':
        await this.diffService.showInteractiveDiff(content, webview);
        return true;
      case 'show_multi_edit_diff':
      case 'show_edit_preview_diff':
      case 'show_edit_full_diff':
        await this.diffService.showEditDiff(event, content);
        return true;
      default:
        return false;
    }
  }
}
