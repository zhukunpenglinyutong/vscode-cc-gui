import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction } from './helpers';
import { CliStatusDetector } from '../../cli/CliStatusDetector';

/**
 * Frontend bridge for CLI install/version detection (Settings → CLI tab).
 * Does not install CLIs; the UI only shows install instructions when missing.
 */
export class CliStatusHandler implements BridgeHandler {
  readonly supportedEvents = ['get_cli_status'] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, webview }: BridgeMessage): Promise<boolean> {
    if (event !== 'get_cli_status') return false;
    this.pushStatus(webview);
    return true;
  }

  private pushStatus(webview: vscode.Webview): void {
    try {
      const statuses = CliStatusDetector.detectAll(true);
      callWindowFunction(webview, 'updateCliStatus', statuses);
    } catch (error) {
      this.context.log.appendLine(
        `[CliStatus] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      callWindowFunction(webview, 'updateCliStatus', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
