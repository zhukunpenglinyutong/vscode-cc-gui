import * as vscode from 'vscode';
import { BridgeServer } from './bridge';
import { CcGuiPanel } from './panel';

export interface SessionTemplate {
  name: string;
  provider: 'claude' | 'codex';
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  cwd: string;
  psiContextEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const SESSION_TEMPLATES_KEY = 'ccg.session_templates';

export class SessionTemplateService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeServer,
    private readonly panel: CcGuiPanel,
  ) {}

  async saveCurrentSessionAsTemplate(): Promise<void> {
    const name = (await vscode.window.showInputBox({
      title: 'Save Session Template',
      prompt: 'Template name',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Template name is required',
    }))?.trim();
    if (!name) return;

    const templates = this.getAllTemplates();
    if (templates.some((template) => template.name === name)) {
      const overwrite = await vscode.window.showWarningMessage(
        `Template "${name}" already exists. Overwrite it?`,
        { modal: true },
        'Overwrite',
      );
      if (overwrite !== 'Overwrite') return;
    }

    const now = new Date().toISOString();
    const existing = templates.find((template) => template.name === name);
    const template: SessionTemplate = {
      name,
      provider: this.bridge.getActiveProvider(),
      model: this.bridge.getSelectedModel(),
      permissionMode: this.bridge.getPermissionMode(),
      reasoningEffort: this.bridge.getReasoningEffort(),
      cwd: this.bridge.getEffectiveWorkingDirectory(),
      psiContextEnabled: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.context.globalState.update(
      SESSION_TEMPLATES_KEY,
      [...templates.filter((item) => item.name !== name), template],
    );
    vscode.window.showInformationMessage(`Session template saved: ${name}`);
  }

  async createSessionFromTemplate(): Promise<void> {
    const templates = this.getAllTemplates();
    if (templates.length === 0) {
      vscode.window.showInformationMessage('No session templates saved yet');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      templates
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((template) => ({
          label: template.name,
          description: `${template.provider}${template.model ? ` · ${template.model}` : ''}`,
          detail: template.cwd || undefined,
          template,
        })),
      {
        title: 'Create Session From Template',
        placeHolder: 'Select a session template',
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;

    await this.applyTemplate(picked.template);
    this.panel.openChatTab(picked.template.name);
    vscode.window.showInformationMessage(`Created session from template: ${picked.template.name}`);
  }

  getAllTemplates(): SessionTemplate[] {
    return this.context.globalState.get<SessionTemplate[]>(SESSION_TEMPLATES_KEY, []);
  }

  private async applyTemplate(template: SessionTemplate): Promise<void> {
    this.bridge.applySessionTemplate(template);
  }
}
