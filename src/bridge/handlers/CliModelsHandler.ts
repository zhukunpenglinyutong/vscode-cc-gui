import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction } from './helpers';
import { NodeDetector } from '../../nodeDetector';
import { isCliOnlyProvider } from '../../cli/cliTools';

const CHANNEL_SCRIPT = 'channel-manager.js';
const TIMEOUT_MS = 50_000;
const MAX_OUTPUT_CHARS = 64_000;
const LIST_MODEL_PROVIDERS = new Set(['kimi', 'opencode', 'pi']);

/**
 * Lists models for headless CLI providers (Kimi / OpenCode / PI) via channel-manager.
 * Frontend: sendBridgeEvent('get_cli_models', provider) → window.setCliModels(...)
 */
export class CliModelsHandler implements BridgeHandler {
  readonly supportedEvents = ['get_cli_models'] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    if (event !== 'get_cli_models') return false;

    const provider = (content || '').trim().toLowerCase();
    if (!LIST_MODEL_PROVIDERS.has(provider) || !isCliOnlyProvider(provider)) {
      this.pushError(webview, provider, `Unsupported CLI provider for model list: ${provider}`);
      return true;
    }

    // Run off the message loop so detection timeouts don't block other events.
    void this.listModels(provider, webview);
    return true;
  }

  private async listModels(provider: string, webview: vscode.Webview): Promise<void> {
    try {
      const node = NodeDetector.find(this.context.extensionContext);
      if (!node) {
        this.pushError(webview, provider, 'Node.js executable not found');
        return;
      }

      const bridgeDir = path.join(this.context.extensionContext.extensionPath, 'ai-bridge');
      const script = path.join(bridgeDir, CHANNEL_SCRIPT);
      if (!fs.existsSync(script)) {
        this.pushError(webview, provider, 'channel-manager.js not found');
        return;
      }

      const args = [script, provider, 'listModels'];
      this.context.log.appendLine(`[CliModels] Listing models for ${provider}: ${node} ${args.join(' ')}`);

      const output = await this.runProcess(node, args, bridgeDir);
      const payload = this.extractJsonObject(output);
      if (!payload) {
        this.pushError(webview, provider, `No model list JSON in ${provider} listModels output`);
        return;
      }
      if (!payload.provider) {
        payload.provider = provider;
      }
      callWindowFunction(webview, 'setCliModels', payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.log.appendLine(`[CliModels] Failed for ${provider}: ${message}`);
      this.pushError(webview, provider, message);
    }
  }

  private runProcess(node: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      const child = cp.spawn(node, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Timed out listing models`));
      }, TIMEOUT_MS);

      const append = (chunk: Buffer | string) => {
        if (output.length >= MAX_OUTPUT_CHARS) return;
        output += chunk.toString();
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS);
        }
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(output);
      });
    });
  }

  private extractJsonObject(raw: string): Record<string, unknown> | null {
    if (!raw) return null;
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj && (obj.models !== undefined || obj.success !== undefined)) {
          return obj;
        }
      } catch {
        // continue
      }
    }
    try {
      const start = raw.lastIndexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private pushError(webview: vscode.Webview, provider: string, message: string): void {
    callWindowFunction(webview, 'setCliModels', {
      success: false,
      provider: provider || '',
      error: message || 'unknown error',
      models: [],
    });
  }
}
