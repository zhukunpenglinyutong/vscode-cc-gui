import * as fs from 'fs';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson } from './helpers';
import { runDshBridgeCommand } from '../services/DshBridgeCommand';
import {
  getDshSettings,
  saveDshSettings,
  validateDshBin,
  validateDshHost,
} from '../services/DshSettingsStore';

const STATUS_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;

/**
 * DSH host lifecycle + connection settings for the Settings CLI card.
 *
 * Frontend protocol:
 *   sendBridgeEvent('get_dsh_status')   → window.updateDshStatus(json)
 *   sendBridgeEvent('start_dsh_host')   → window.updateDshStatus(json)
 *   sendBridgeEvent('stop_dsh_host')    → window.updateDshStatus(json)
 *   sendBridgeEvent('save_dsh_settings', json) → persists the `dsh` config
 *     section and replies window.updateDshStatus(json)
 *
 * Only bin / host / port / autoStart live here. Provider keys and the model
 * catalog stay in the DSH Web UI ($DSH_HOME) — the extension never writes them.
 */
export class DshHostHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_dsh_status',
    'start_dsh_host',
    'stop_dsh_host',
    'save_dsh_settings',
  ] as const;

  // Re-entry guard for start/stop (double clicks); status polls stay unrestricted.
  private lifecycleInProgress = false;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_dsh_status':
        void this.runAndPush(webview, 'status', STATUS_TIMEOUT_MS);
        return true;
      case 'start_dsh_host':
        this.runLifecycleCommand(webview, 'ensureHost', LIFECYCLE_TIMEOUT_MS);
        return true;
      case 'stop_dsh_host':
        this.runLifecycleCommand(webview, 'stopHost', STATUS_TIMEOUT_MS);
        return true;
      case 'save_dsh_settings':
        this.saveSettings(webview, content);
        void this.runAndPush(webview, 'status', STATUS_TIMEOUT_MS);
        return true;
      default:
        return false;
    }
  }

  /**
   * Guard start/stop against re-entry: while one lifecycle command runs,
   * further start/stop requests get an explicit "in progress" error instead
   * of racing it. Status polls are not guarded.
   */
  private runLifecycleCommand(webview: vscode.Webview, command: string, timeoutMs: number): void {
    if (this.lifecycleInProgress) {
      this.pushStatus(webview, this.errorPayload('DSH host operation already in progress'));
      return;
    }
    this.lifecycleInProgress = true;
    void this.runAndPush(webview, command, timeoutMs).finally(() => {
      this.lifecycleInProgress = false;
    });
  }

  private async runAndPush(webview: vscode.Webview, command: string, timeoutMs: number): Promise<void> {
    try {
      const result = await runDshBridgeCommand(this.context.extensionContext, command, { timeoutMs });
      this.pushStatus(webview, result.payload ?? this.errorPayload(result.error || `dsh ${command} failed`));
    } catch (error: any) {
      this.context.log.appendLine(`[DshHost] ${command} failed: ${error?.message || error}`);
      this.pushStatus(webview, this.errorPayload(error?.message || `dsh ${command} failed`));
    }
  }

  private saveSettings(webview: vscode.Webview, content: string): void {
    if (!content || !content.trim()) {
      return;
    }
    try {
      const payload = parseJson<Record<string, any>>(content, {});

      // Parse and validate every field first, then persist in one pass —
      // a failure must never leave the dsh section half-written.
      let bin: string | undefined;
      if ('bin' in payload) {
        bin = payload.bin == null ? '' : String(payload.bin).trim();
        const binError = validateDshBin(bin, (p) => {
          try {
            return fs.existsSync(p) ? fs.statSync(p) : null;
          } catch {
            return null;
          }
        });
        if (binError) {
          this.pushStatus(webview, this.errorPayload(binError));
          return;
        }
      }
      let host: string | undefined;
      if ('host' in payload) {
        host = payload.host == null ? '' : String(payload.host).trim();
        const hostError = validateDshHost(host);
        if (hostError) {
          this.pushStatus(webview, this.errorPayload(hostError));
          return;
        }
      }
      let port: number | undefined;
      if ('port' in payload && payload.port != null) {
        const parsed = Number(payload.port);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          this.pushStatus(webview, this.errorPayload(`Invalid DSH port: ${payload.port}`));
          return;
        }
        port = parsed;
      }
      let autoStart: boolean | undefined;
      if ('autoStart' in payload && payload.autoStart != null) {
        autoStart = payload.autoStart === true;
      }

      saveDshSettings({ bin, host, port, autoStart });
    } catch (error: any) {
      this.context.log.appendLine(`[DshHost] Failed to save settings: ${error?.message || error}`);
      this.pushStatus(webview, this.errorPayload(`Invalid DSH settings: ${error?.message || 'parse error'}`));
    }
  }

  private errorPayload(message: string): Record<string, any> {
    return { success: false, provider: 'dsh', error: message };
  }

  private pushStatus(webview: vscode.Webview, payload: Record<string, any>): void {
    // Always echo the effective settings so the card can reflect them.
    try {
      const settings = getDshSettings();
      payload.settings = {
        bin: settings.bin,
        host: settings.host,
        port: settings.port,
        autoStart: settings.autoStart,
      };
    } catch {
      // settings echo is best-effort
    }
    callWindowFunction(webview, 'updateDshStatus', payload);
  }
}
