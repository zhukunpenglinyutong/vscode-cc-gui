import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { asArray, callWindowFunction, parseJson, postJson } from './helpers';
import { codemossConfigPath, readCodemossConfigFile, writeCodemossConfigFile } from '../services/codemossJsonStore';

// Legacy VS Code-only storage keys, read once to migrate existing users into the shared
// ~/.codemoss/agent.json file that jetbrains-cc-gui also reads/writes.
const AGENTS_KEY = 'ccg.agents';
const SELECTED_AGENT_KEY = 'ccg.selected_agent_id';

interface AgentConfigFile {
  agents: Record<string, any>;
  selectedAgentId?: string;
}

export class AgentHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_agents',
    'add_agent',
    'update_agent',
    'delete_agent',
    'get_selected_agent',
    'set_selected_agent',
    'export_agents',
    'import_agents_file',
    'save_imported_agents',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_agents':
        this.postAgents(webview);
        return true;

      case 'add_agent': {
        const agents = this.getAgents();
        const agent = parseJson<any>(content, {});
        agent.id = agent.id ?? Date.now().toString();
        agents.push(agent);
        await this.saveAgents(agents);
        this.postAgents(webview);
        callWindowFunction(webview, 'agentOperationResult', { success: true, operation: 'add' });
        return true;
      }

      case 'update_agent': {
        const { id, updates } = parseJson<any>(content, {});
        const agents = this.getAgents().map((agent: any) => agent.id === id ? { ...agent, ...updates } : agent);
        await this.saveAgents(agents);
        this.postAgents(webview);
        callWindowFunction(webview, 'agentOperationResult', { success: true, operation: 'update' });
        return true;
      }

      case 'delete_agent': {
        const { id } = parseJson<any>(content, {});
        const agents = this.getAgents().filter((agent: any) => agent.id !== id);
        await this.saveAgents(agents);
        this.postAgents(webview);
        callWindowFunction(webview, 'agentOperationResult', { success: true, operation: 'delete' });
        return true;
      }

      case 'get_selected_agent':
        this.postSelectedAgent(webview);
        return true;

      case 'set_selected_agent': {
        const payload = parseJson<any>(content, {});
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const config = this.readAgentConfigFile();
        writeCodemossConfigFile(this.agentFilePath(), { ...config, selectedAgentId: id || undefined });
        this.postSelectedAgent(webview, id);
        return true;
      }

      case 'export_agents':
        await this.exportAgents(content, webview);
        return true;

      case 'import_agents_file':
        await this.importAgentsFile(webview);
        return true;

      case 'save_imported_agents':
        await this.saveImportedAgents(content, webview);
        return true;

      default:
        return false;
    }
  }

  private agentFilePath(): string {
    return codemossConfigPath('agent.json');
  }

  private readAgentConfigFile(): AgentConfigFile {
    this.migrateLegacyAgentsIfNeeded();
    const config = readCodemossConfigFile<AgentConfigFile>(this.agentFilePath(), { agents: {} });
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    return config;
  }

  /** One-time migration for existing users: seeds ~/.codemoss/agent.json from the old VS Code-only globalState store. */
  private migrateLegacyAgentsIfNeeded(): void {
    const filePath = this.agentFilePath();
    if (fs.existsSync(filePath)) return;
    const legacyAgents = this.context.extensionContext.globalState.get<any[]>(AGENTS_KEY) ?? [];
    const legacySelected = this.context.extensionContext.globalState.get<string>(SELECTED_AGENT_KEY);
    if (legacyAgents.length === 0 && !legacySelected) return;
    const agents: Record<string, any> = {};
    for (const agent of legacyAgents) {
      if (agent?.id) agents[String(agent.id)] = agent;
    }
    writeCodemossConfigFile(filePath, { agents, selectedAgentId: legacySelected || undefined });
  }

  private getAgents(): any[] {
    const { agents } = this.readAgentConfigFile();
    return Object.keys(agents).map((id) => ({ ...agents[id], id }));
  }

  private saveAgents(agents: any[]): void {
    const config = this.readAgentConfigFile();
    const map: Record<string, any> = {};
    for (const agent of agents) {
      if (agent?.id) map[String(agent.id)] = agent;
    }
    writeCodemossConfigFile(this.agentFilePath(), { ...config, agents: map });
  }

  private postAgents(webview: vscode.Webview): void {
    postJson(webview, 'update_agents', this.getAgents());
  }

  private postSelectedAgent(webview: vscode.Webview, explicitId?: string): void {
    const id = explicitId ?? this.readAgentConfigFile().selectedAgentId ?? '';
    const agent = this.getAgents().find((item: any) => item.id === id) ?? null;
    callWindowFunction(webview, explicitId === undefined ? 'onSelectedAgentReceived' : 'onSelectedAgentChanged', agent);
  }

  private async exportAgents(content: string, webview: vscode.Webview): Promise<void> {
    const { agentIds } = parseJson<any>(content, {});
    const selected = new Set(asArray<string>(agentIds).map(String));
    const agents = selected.size > 0
      ? this.getAgents().filter((agent: any) => selected.has(String(agent.id)))
      : this.getAgents();
    const uri = await vscode.window.showSaveDialog({
      title: 'Export Agents',
      filters: { JSON: ['json'] },
      defaultUri: vscode.Uri.file(path.join(this.context.getWorkspacePath() || process.cwd(), 'agents.json')),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ agents }, null, 2), 'utf8'));
    callWindowFunction(webview, 'showSuccess', 'Agents exported');
  }

  private async importAgentsFile(webview: vscode.Webview): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
      title: 'Import Agents',
    });
    if (!uris?.[0]) return;
    try {
      const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const imported = Array.isArray(parsed?.agents) ? parsed.agents : Array.isArray(parsed) ? parsed : [];
      const existingIds = new Set(this.getAgents().map((agent: any) => String(agent.id)));
      const items = imported
        .filter((agent: any) => agent && typeof agent === 'object' && agent.id && agent.name)
        .map((agent: any) => ({
          data: agent,
          status: existingIds.has(String(agent.id)) ? 'update' : 'new',
          conflict: existingIds.has(String(agent.id)),
        }));
      callWindowFunction(webview, 'agentImportPreviewResult', {
        items,
        summary: {
          total: items.length,
          newCount: items.filter((item: any) => item.status === 'new').length,
          updateCount: items.filter((item: any) => item.status === 'update').length,
        },
      });
    } catch (error) {
      callWindowFunction(webview, 'agentImportResult', { success: false, imported: 0, updated: 0, skipped: 0, error: String(error) });
    }
  }

  private async saveImportedAgents(content: string, webview: vscode.Webview): Promise<void> {
    const payload = parseJson<any>(content, {});
    const incoming = asArray<any>(payload.agents);
    const strategy = payload.strategy === 'overwrite' || payload.strategy === 'duplicate' ? payload.strategy : 'skip';
    const agents = this.getAgents();
    const byId = new Map(agents.map((agent: any) => [String(agent.id), agent]));
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const agent of incoming) {
      if (!agent?.id || !agent?.name) {
        skipped += 1;
        continue;
      }
      const id = String(agent.id);
      const exists = byId.has(id);
      if (!exists) {
        agents.push(agent);
        byId.set(id, agent);
        imported += 1;
      } else if (strategy === 'overwrite') {
        const index = agents.findIndex((item: any) => String(item.id) === id);
        if (index >= 0) agents[index] = { ...agents[index], ...agent };
        updated += 1;
      } else if (strategy === 'duplicate') {
        agents.push({ ...agent, id: `${Date.now()}_${Math.random().toString(16).slice(2)}` });
        imported += 1;
      } else {
        skipped += 1;
      }
    }

    await this.saveAgents(agents);
    this.postAgents(webview);
    callWindowFunction(webview, 'agentImportResult', { success: true, imported, updated, skipped });
  }
}
