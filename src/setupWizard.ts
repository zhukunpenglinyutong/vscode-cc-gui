import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { NodeDetector } from './nodeDetector';
import {
  SETUP_COMPLETED_KEY,
  SETUP_SKIPPED_AT_KEY,
  ensureSdkInstallScaffolding,
  evaluateNodeStatus,
  listSdkIds,
  sdkPackageName,
  snapshotSdks,
  summarizeWizardSnapshot,
  type NodeStatus,
  type SdkStatus,
} from './setupWizardHelpers';

export class SetupWizardService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async run(): Promise<void> {
    const proceed = await this.showWelcome();
    if (!proceed) {
      await this.markSkipped();
      return;
    }

    await this.runNodeStep();
    await this.runSdkStep();
    await this.runProviderStep();

    await this.markCompleted();
    vscode.window.showInformationMessage('CC GUI setup complete. You can re-run via "CC GUI: Run Setup Wizard".');
  }

  async markSkipped(): Promise<void> {
    await this.context.globalState.update(SETUP_SKIPPED_AT_KEY, Date.now());
  }

  async markCompleted(): Promise<void> {
    await this.context.globalState.update(SETUP_COMPLETED_KEY, true);
    await this.context.globalState.update(SETUP_SKIPPED_AT_KEY, undefined);
  }

  private async showWelcome(): Promise<boolean> {
    const node = this.detectNode();
    const sdks = snapshotSdks();
    const summary = summarizeWizardSnapshot({ node, sdks });
    const message = `CC GUI setup wizard.\n\n${summary}`;
    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      'Start',
      'Skip for now',
    );
    return choice === 'Start';
  }

  private async runNodeStep(): Promise<void> {
    const status = this.detectNode();
    if (status.available && !status.warning) {
      await vscode.window.showInformationMessage(`Node.js detected: ${status.version} at ${status.path}`);
      return;
    }

    const description = status.warning === 'too_old'
      ? `Detected ${status.version} at ${status.path}. CC GUI requires Node.js 20 or higher (you can keep Node 16 for project work and point CC GUI at a separate Node 20+ install).`
      : 'Node.js was not detected on common paths or $PATH.';

    const action = await vscode.window.showWarningMessage(
      description,
      'Set custom Node path',
      'Open Node.js website',
      'Continue',
    );

    if (action === 'Set custom Node path') {
      const input = await vscode.window.showInputBox({
        title: 'Custom Node.js executable path',
        prompt: 'Absolute path to a node binary for CC GUI only (>= 20; project may still use Node 16)',
        ignoreFocusOut: true,
      });
      const trimmed = input?.trim();
      if (trimmed) {
        await vscode.workspace.getConfiguration('ccGui').update('nodePath', trimmed, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Saved custom Node path: ${trimmed}`);
      }
    } else if (action === 'Open Node.js website') {
      await vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/en/download'));
    }
  }

  private async runSdkStep(): Promise<void> {
    const sdks = snapshotSdks();
    const missing = sdks.filter((sdk) => !sdk.installed);
    if (missing.length === 0) {
      await vscode.window.showInformationMessage('Claude and Codex SDKs are already installed.');
      return;
    }

    const picks = await vscode.window.showQuickPick(
      missing.map((sdk) => ({
        label: sdk.name,
        description: 'not installed',
        detail: sdk.pkg,
        picked: true,
        sdkId: sdk.id,
      })),
      {
        title: 'Install missing AI SDKs',
        canPickMany: true,
        placeHolder: 'Select SDKs to install now (or press Esc to skip)',
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) {
      return;
    }

    for (const pick of picks) {
      await this.installSdk(pick.sdkId);
    }
  }

  private async runProviderStep(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'Configure a Claude or Codex provider in the CC GUI side panel to start chatting.',
      'Open Side Panel',
      'Later',
    );
    if (action === 'Open Side Panel') {
      try {
        await vscode.commands.executeCommand('ccGui.mainView.focus');
      } catch { /* ignore */ }
    }
  }

  private detectNode(): NodeStatus {
    const detectedPath = NodeDetector.find(this.context);
    if (!detectedPath) {
      return evaluateNodeStatus(undefined, undefined);
    }
    let versionOutput: string | undefined;
    try {
      versionOutput = cp.execFileSync(detectedPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    } catch { /* ignore */ }
    return evaluateNodeStatus(detectedPath, versionOutput);
  }

  private async installSdk(sdkId: string): Promise<void> {
    const pkg = sdkPackageName(sdkId);
    if (!pkg) return;
    const { dir } = ensureSdkInstallScaffolding(sdkId);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Installing ${pkg}...`,
        cancellable: false,
      },
      async () => {
        await new Promise<void>((resolve) => {
          const npmPath = NodeDetector.findNpm(this.context) ?? 'npm';
          const npmCommand = process.platform === 'win32' ? path.basename(npmPath) : npmPath;
          const proc = cp.spawn(npmCommand, ['install', pkg], {
            cwd: dir,
            env: process.env,
            shell: process.platform === 'win32',
          });
          proc.on('close', () => resolve());
          proc.on('error', () => resolve());
        });
      },
    );
  }
}

export function registerSetupWizard(context: vscode.ExtensionContext): SetupWizardService {
  const wizard = new SetupWizardService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('ccGui.runSetupWizard', async () => {
      await wizard.run();
    }),
  );

  return wizard;
}

export function _internal_listSdkIds(): string[] {
  return listSdkIds();
}

export type { SdkStatus, NodeStatus };
