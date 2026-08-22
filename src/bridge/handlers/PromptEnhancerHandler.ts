import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson } from './helpers';
import { NodeDetector } from '../../nodeDetector';

const ENHANCE_TIMEOUT_MS = 60_000;
const CURSOR_CONTEXT_LINES = 10;

const ENHANCE_SYSTEM_PROMPT =
  'You are a prompt optimization expert. Optimize the user prompt so it is clearer, more specific, and less ambiguous. ' +
  'Output only the optimized prompt itself, with no explanations, prefixes, headings, or Markdown. ' +
  'Keep the same language as the original prompt. Preserve the original intent and use any supplied editor context only to clarify vague references.';

interface EnhancePromptPayload {
  prompt?: string;
  model?: string;
  systemPrompt?: string;
}

export class PromptEnhancerHandler implements BridgeHandler {
  readonly supportedEvents = ['enhance_prompt'] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    if (event !== 'enhance_prompt') return false;
    await this.enhancePrompt(content, webview);
    return true;
  }

  private async enhancePrompt(content: string, webview: vscode.Webview): Promise<void> {
    const payload = parseJson<EnhancePromptPayload>(content, { prompt: content });
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) {
      callWindowFunction(webview, 'updateEnhancedPrompt', {
        success: false,
        enhancedPrompt: '',
        error: 'Prompt is empty',
      });
      return;
    }

    const nodePath = NodeDetector.find(this.context.extensionContext);
    if (!nodePath) {
      callWindowFunction(webview, 'updateEnhancedPrompt', {
        success: false,
        enhancedPrompt: '',
        error: 'Node.js not found',
      });
      return;
    }

    const scriptPath = path.join(this.context.extensionContext.extensionPath, 'ai-bridge', 'services', 'prompt-enhancer.js');
    if (!fs.existsSync(scriptPath)) {
      callWindowFunction(webview, 'updateEnhancedPrompt', {
        success: false,
        enhancedPrompt: '',
        error: 'Prompt enhancer service not found',
      });
      return;
    }

    const request = {
      prompt,
      model: payload.model ?? '',
      systemPrompt: payload.systemPrompt ?? ENHANCE_SYSTEM_PROMPT,
      context: this.collectEditorContext(),
    };

    try {
      const enhancedPrompt = await this.runPromptEnhancer(nodePath, scriptPath, request);
      callWindowFunction(webview, 'updateEnhancedPrompt', {
        success: true,
        enhancedPrompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.log.appendLine(`[PromptEnhancer] failed: ${message}`);
      callWindowFunction(webview, 'updateEnhancedPrompt', {
        success: false,
        enhancedPrompt: '',
        error: message,
      });
    }
  }

  private collectEditorContext(): Record<string, unknown> | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return null;
    }

    const document = editor.document;
    const filePath = document.uri.fsPath;
    const context: Record<string, unknown> = {
      currentFile: {
        path: filePath,
        language: document.languageId || this.languageFromPath(filePath),
        content: document.getText().slice(0, 20_000),
      },
      cursorPosition: {
        line: editor.selection.active.line + 1,
        column: editor.selection.active.character + 1,
      },
      projectType: this.detectProjectType(),
    };

    if (!editor.selection.isEmpty) {
      context.selectedCode = document.getText(editor.selection);
      context.selectionRange = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
      };
    } else {
      const activeLine = editor.selection.active.line;
      const startLine = Math.max(0, activeLine - CURSOR_CONTEXT_LINES);
      const endLine = Math.min(document.lineCount - 1, activeLine + CURSOR_CONTEXT_LINES);
      const range = new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
      context.cursorContext = document.getText(range);
    }

    return context;
  }

  private runPromptEnhancer(nodePath: string, scriptPath: string, request: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(nodePath, [scriptPath], {
        cwd: path.dirname(path.dirname(scriptPath)),
        env: { ...process.env, WORKSPACE_PATH: this.context.getWorkspacePath() },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(new Error('Prompt enhancement timed out'));
      }, ENHANCE_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      proc.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith('[ENHANCED]'));
        const result = markerLine?.slice('[ENHANCED]'.length).replace(/\{\{NEWLINE\}\}/g, '\n').trim();
        if (result) {
          resolve(result);
          return;
        }
        reject(new Error(stderr.trim() || 'Prompt enhancement returned empty result'));
      });

      proc.stdin.end(JSON.stringify(request));
    });
  }

  private detectProjectType(): string {
    const workspacePath = this.context.getWorkspacePath();
    if (!workspacePath) return '';
    const markers: Array<[string, string]> = [
      ['package.json', 'Node.js'],
      ['pom.xml', 'Java Maven'],
      ['build.gradle', 'Java Gradle'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['Cargo.toml', 'Rust'],
      ['go.mod', 'Go'],
    ];
    for (const [file, type] of markers) {
      if (fs.existsSync(path.join(workspacePath, file))) {
        return type;
      }
    }
    return '';
  }

  private languageFromPath(filePath: string): string {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    return ({
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      java: 'java',
      kt: 'kotlin',
      go: 'go',
      rs: 'rust',
      rb: 'ruby',
      php: 'php',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      vue: 'vue',
      html: 'html',
      css: 'css',
      json: 'json',
      md: 'markdown',
      sh: 'bash',
    } as Record<string, string>)[ext] ?? 'text';
  }
}
