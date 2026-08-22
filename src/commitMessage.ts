import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { BridgeServer } from './bridge';
import { SettingsStore } from './bridge/services/SettingsStore';
import {
  buildCommitPrompt,
  cleanupCommitMessage,
  getUserAdditionalPrompt,
  truncateDiff,
} from './commitMessageHelpers';

export { buildCommitPrompt, cleanupCommitMessage } from './commitMessageHelpers';

export interface CommitMessageGenerationResult {
  commitMessage?: string;
  prompt: string;
  diff: string;
  provider?: string | null;
  error?: string;
}

export interface CommitMessageGenerateOptions {
  /** Streaming preview of the commit message (may be partial). */
  onProgress?: (partial: string) => void;
}

export class CommitMessageService {
  private readonly store: SettingsStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeServer,
  ) {
    this.store = new SettingsStore(context);
  }

  isEnabled(): boolean {
    return this.store.getCommitGenerationEnabled();
  }

  async generate(
    workspacePath: string,
    options: CommitMessageGenerateOptions = {},
  ): Promise<CommitMessageGenerationResult> {
    const diff = this.getGitDiff(workspacePath);
    if (!diff.trim()) {
      throw new Error('No changes found');
    }

    const prompt = this.buildPrompt(diff, workspacePath);
    const config = this.store.getCommitAiConfig();
    const provider = this.resolveProvider(config);
    const model = provider ? this.resolveModel(config, provider) : null;

    if (!provider) {
      return {
        prompt,
        diff,
        provider,
        error: 'No available Commit AI provider',
      };
    }

    try {
      const raw = await this.bridge.requestAiText(provider, prompt, {
        model: model ?? undefined,
        disableThinking: true,
        streaming: Boolean(options.onProgress),
        onProgress: options.onProgress
          ? (partial) => {
              const cleaned = cleanupCommitMessage(partial);
              if (cleaned) options.onProgress?.(cleaned);
            }
          : undefined,
      });
      const commitMessage = cleanupCommitMessage(raw);
      if (!commitMessage) {
        return {
          prompt,
          diff,
          provider,
          error: 'AI returned an empty commit message',
        };
      }
      return { prompt, diff, provider, commitMessage };
    } catch (error: any) {
      return {
        prompt,
        diff,
        provider,
        error: error?.message || String(error),
      };
    }
  }

  buildPrompt(diff: string, workspacePath: string): string {
    const userPrompt = getUserAdditionalPrompt(this.store.getCommitPrompt());
    const projectPrompt = this.store.getProjectCommitPrompt(workspacePath).trim();
    return buildCommitPrompt(diff, userPrompt, projectPrompt);
  }

  private getGitDiff(workspacePath: string): string {
    const staged = this.runGitDiff(workspacePath, ['diff', '--cached', '--no-ext-diff', '--']);
    if (staged.trim()) {
      return truncateDiff(staged);
    }
    return truncateDiff(this.runGitDiff(workspacePath, ['diff', '--no-ext-diff', '--']));
  }

  private runGitDiff(workspacePath: string, args: string[]): string {
    try {
      return cp.execFileSync('git', args, {
        cwd: workspacePath,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 8,
        timeout: 10000,
      });
    } catch {
      return '';
    }
  }

  private resolveProvider(config: any): 'claude' | 'codex' | null {
    const provider = typeof config?.effectiveProvider === 'string'
      ? config.effectiveProvider.trim()
      : typeof config?.provider === 'string'
        ? config.provider.trim()
        : '';
    return provider === 'claude' || provider === 'codex' ? provider : null;
  }

  private resolveModel(config: any, provider: 'claude' | 'codex'): string | null {
    const model = config?.models?.[provider];
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  }
}

export function setScmCommitInputBox(message: string): boolean {
  try {
    vscode.scm.inputBox.value = message;
    return true;
  } catch {
    return false;
  }
}

export function getWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

export function getWorkspaceName(workspacePath: string): string {
  return workspacePath ? path.basename(workspacePath) : '';
}
