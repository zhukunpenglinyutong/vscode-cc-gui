import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { asArray, callWindowFunction, parseJson, postJson } from './helpers';
import { codemossConfigPath, readCodemossConfigFile, writeCodemossConfigFile } from '../services/codemossJsonStore';

// Legacy VS Code-only storage keys, read once to migrate existing users into the shared
// prompt.json files that jetbrains-cc-gui also reads/writes.
const GLOBAL_PROMPTS_LEGACY_KEY = 'ccg.prompts.global';
const PROJECT_PROMPTS_LEGACY_KEY = 'ccg.prompts.projectMap';

interface PromptConfigFile {
  prompts: Record<string, any>;
}

export class PromptHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_project_info',
    'get_prompts',
    'add_prompt',
    'update_prompt',
    'delete_prompt',
    'export_prompts',
    'import_prompts_file',
    'save_imported_prompts',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_project_info':
        callWindowFunction(webview, 'updateProjectInfo', this.getProjectInfo());
        return true;
      case 'get_prompts': {
        const scope = this.parseScope(content);
        this.postPrompts(scope, webview);
        return true;
      }
      case 'add_prompt':
        await this.addPrompt(content, webview);
        return true;
      case 'update_prompt':
        await this.updatePrompt(content, webview);
        return true;
      case 'delete_prompt':
        await this.deletePrompt(content, webview);
        return true;
      case 'export_prompts':
        await this.exportPrompts(content, webview);
        return true;
      case 'import_prompts_file':
        await this.importPromptsFile(content, webview);
        return true;
      case 'save_imported_prompts':
        await this.saveImportedPrompts(content, webview);
        return true;
      default:
        return false;
    }
  }

  private parseScope(content: string): 'global' | 'project' {
    return parseJson<any>(content, {}).scope === 'project' ? 'project' : 'global';
  }

  private getProjectInfo(): { name: string; path: string; available: boolean } {
    const workspacePath = this.context.getWorkspacePath();
    return {
      name: workspacePath ? path.basename(workspacePath) : '',
      path: workspacePath,
      available: !!workspacePath,
    };
  }

  private projectKey(): string {
    return this.context.getWorkspacePath() || '__NO_PROJECT__';
  }

  /** Global prompts live in ~/.codemoss/prompt.json; project prompts live in <workspace>/.codemoss/prompt.json. */
  private promptFilePath(scope: 'global' | 'project'): string | null {
    if (scope === 'global') return codemossConfigPath('prompt.json');
    const workspacePath = this.context.getWorkspacePath();
    return workspacePath ? path.join(workspacePath, '.codemoss', 'prompt.json') : null;
  }

  /** One-time migration for existing users: seeds the shared prompt.json from the old VS Code-only globalState store. */
  private migrateLegacyPromptsIfNeeded(scope: 'global' | 'project'): void {
    const filePath = this.promptFilePath(scope);
    if (!filePath || fs.existsSync(filePath)) return;
    const legacy = scope === 'global'
      ? this.context.extensionContext.globalState.get<any[]>(GLOBAL_PROMPTS_LEGACY_KEY) ?? []
      : (this.context.extensionContext.globalState.get<Record<string, any[]>>(PROJECT_PROMPTS_LEGACY_KEY) ?? {})[this.projectKey()] ?? [];
    if (legacy.length === 0) return;
    const prompts: Record<string, any> = {};
    for (const prompt of legacy) {
      if (prompt?.id) prompts[String(prompt.id)] = prompt;
    }
    writeCodemossConfigFile(filePath, { prompts });
  }

  private readPromptConfigFile(scope: 'global' | 'project'): PromptConfigFile {
    this.migrateLegacyPromptsIfNeeded(scope);
    const filePath = this.promptFilePath(scope);
    if (!filePath) return { prompts: {} };
    const config = readCodemossConfigFile<PromptConfigFile>(filePath, { prompts: {} });
    if (!config.prompts || typeof config.prompts !== 'object') config.prompts = {};
    return config;
  }

  private getPrompts(scope: 'global' | 'project'): any[] {
    const { prompts } = this.readPromptConfigFile(scope);
    return Object.keys(prompts).map((id) => ({ ...prompts[id], id }));
  }

  private async savePrompts(scope: 'global' | 'project', prompts: any[]): Promise<void> {
    const filePath = this.promptFilePath(scope);
    if (!filePath) return;
    const map: Record<string, any> = {};
    for (const prompt of prompts) {
      if (prompt?.id) map[String(prompt.id)] = prompt;
    }
    writeCodemossConfigFile(filePath, { prompts: map });
  }

  private postPrompts(scope: 'global' | 'project', webview: vscode.Webview, prompts?: any[]): void {
    const list = Array.isArray(prompts) ? prompts : this.getPrompts(scope);
    callWindowFunction(webview, scope === 'project' ? 'updateProjectPrompts' : 'updateGlobalPrompts', list);
    postJson(webview, 'update_prompts', list);
  }

  private async addPrompt(content: string, webview: vscode.Webview): Promise<void> {
    try {
      const payload = parseJson<any>(content, {});
      const scope = this.parseScope(content);
      const prompt = payload.prompt;
      if (!prompt?.id || !prompt?.name) throw new Error('Invalid prompt payload');
      const list = this.getPrompts(scope);
      list.push({
        id: String(prompt.id),
        name: String(prompt.name),
        content: String(prompt.content ?? ''),
        createdAt: Number(prompt.createdAt ?? Date.now()),
        updatedAt: Number(prompt.updatedAt ?? Date.now()),
      });
      await this.savePrompts(scope, list);
      this.postPrompts(scope, webview, list);
      callWindowFunction(webview, 'promptOperationResult', { success: true, operation: 'add' });
    } catch (error) {
      callWindowFunction(webview, 'promptOperationResult', { success: false, operation: 'add', error: String(error) });
    }
  }

  private async updatePrompt(content: string, webview: vscode.Webview): Promise<void> {
    try {
      const payload = parseJson<any>(content, {});
      const scope = this.parseScope(content);
      const id = String(payload.id ?? '');
      if (!id) throw new Error('Invalid prompt id');
      const list = this.getPrompts(scope).map((item: any) =>
        item.id === id ? { ...item, ...(payload.updates ?? {}), id } : item
      );
      await this.savePrompts(scope, list);
      this.postPrompts(scope, webview, list);
      callWindowFunction(webview, 'promptOperationResult', { success: true, operation: 'update' });
    } catch (error) {
      callWindowFunction(webview, 'promptOperationResult', { success: false, operation: 'update', error: String(error) });
    }
  }

  private async deletePrompt(content: string, webview: vscode.Webview): Promise<void> {
    try {
      const payload = parseJson<any>(content, {});
      const scope = this.parseScope(content);
      const id = String(payload.id ?? '');
      const list = this.getPrompts(scope).filter((item: any) => item.id !== id);
      await this.savePrompts(scope, list);
      this.postPrompts(scope, webview, list);
      callWindowFunction(webview, 'promptOperationResult', { success: true, operation: 'delete' });
    } catch (error) {
      callWindowFunction(webview, 'promptOperationResult', { success: false, operation: 'delete', error: String(error) });
    }
  }

  private async exportPrompts(content: string, webview: vscode.Webview): Promise<void> {
    const payload = parseJson<any>(content, {});
    const scope = this.parseScope(content);
    const selectedIds = new Set(asArray<string>(payload.promptIds).map(String));
    const items = selectedIds.size > 0
      ? this.getPrompts(scope).filter((prompt: any) => selectedIds.has(String(prompt.id)))
      : this.getPrompts(scope);
    const uri = await vscode.window.showSaveDialog({
      title: 'Export Prompts',
      filters: { JSON: ['json'] },
      defaultUri: vscode.Uri.file(path.join(this.context.getWorkspacePath() || process.cwd(), `prompts-${scope}.json`)),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ scope, prompts: items }, null, 2), 'utf8'));
    callWindowFunction(webview, 'showSuccess', 'Prompts exported');
  }

  private async importPromptsFile(content: string, webview: vscode.Webview): Promise<void> {
    const scope = this.parseScope(content);
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
      title: 'Import Prompts',
    });
    if (!uris?.[0]) return;
    try {
      const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const imported = Array.isArray(parsed?.prompts) ? parsed.prompts : Array.isArray(parsed) ? parsed : [];
      const existingIds = new Set(this.getPrompts(scope).map((prompt: any) => String(prompt.id)));
      const items = imported
        .filter((prompt: any) => prompt && typeof prompt === 'object' && prompt.id && prompt.name)
        .map((prompt: any) => ({
          data: prompt,
          status: existingIds.has(String(prompt.id)) ? 'update' : 'new',
          conflict: existingIds.has(String(prompt.id)),
        }));
      callWindowFunction(webview, 'promptImportPreviewResult', {
        items,
        summary: {
          total: items.length,
          newCount: items.filter((item: any) => item.status === 'new').length,
          updateCount: items.filter((item: any) => item.status === 'update').length,
        },
      });
    } catch (error) {
      callWindowFunction(webview, 'promptImportResult', { success: false, imported: 0, updated: 0, skipped: 0, scope, error: String(error) });
    }
  }

  private async saveImportedPrompts(content: string, webview: vscode.Webview): Promise<void> {
    const payload = parseJson<any>(content, {});
    const scope = this.parseScope(content);
    const incoming = asArray<any>(payload.prompts);
    const strategy = payload.strategy === 'overwrite' || payload.strategy === 'duplicate' ? payload.strategy : 'skip';
    const list = this.getPrompts(scope);
    const byId = new Map(list.map((prompt: any) => [String(prompt.id), prompt]));
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawPrompt of incoming) {
      if (!rawPrompt?.id || !rawPrompt?.name) {
        skipped += 1;
        continue;
      }
      const id = String(rawPrompt.id);
      const exists = byId.has(id);
      if (!exists) {
        list.push(rawPrompt);
        byId.set(id, rawPrompt);
        imported += 1;
      } else if (strategy === 'overwrite') {
        const index = list.findIndex((item: any) => String(item.id) === id);
        if (index >= 0) list[index] = { ...list[index], ...rawPrompt };
        updated += 1;
      } else if (strategy === 'duplicate') {
        list.push({ ...rawPrompt, id: `${Date.now()}_${Math.random().toString(16).slice(2)}` });
        imported += 1;
      } else {
        skipped += 1;
      }
    }

    await this.savePrompts(scope, list);
    this.postPrompts(scope, webview, list);
    callWindowFunction(webview, 'promptImportResult', { success: true, imported, updated, skipped, scope });
  }
}
