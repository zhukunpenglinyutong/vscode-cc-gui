import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export class CodexSettingsStore {
  private readonly codexDir = path.join(homedir(), '.codex');

  applyProvider(provider: any | null): void {
    if (!provider) {
      return;
    }

    if (provider.id === '__codex_cli_login__') {
      return;
    }

    // Never overwrite ~/.codex/config.toml with an empty payload.
    // Empty configToml is common for incomplete/imported providers; writing it
    // would wipe the user's cc-switch / CLI config on provider switch.
    if (typeof provider.configToml === 'string' && provider.configToml.trim()) {
      this.writeFileAtomically(this.configTomlPath(), provider.configToml);
    }

    if (typeof provider.authJson === 'string' && provider.authJson.trim()) {
      const parsed = JSON.parse(provider.authJson);
      this.writeFileAtomically(this.authJsonPath(), JSON.stringify(parsed, null, 2));
    }
  }

  getCurrentConfig(): { configToml: string; authJson: string; exists: { configToml: boolean; authJson: boolean } } {
    return {
      configToml: this.readText(this.configTomlPath()),
      authJson: this.readText(this.authJsonPath()),
      exists: {
        configToml: fs.existsSync(this.configTomlPath()),
        authJson: fs.existsSync(this.authJsonPath()),
      },
    };
  }

  applyCliLoginMode(): void {
    const configPath = this.configTomlPath();
    const backupPath = path.join(this.codexDir, 'config.toml.cli_backup');
    this.ensureCodexDir();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      if (content.trim()) {
        fs.copyFileSync(configPath, backupPath);
      }
    }
    this.writeFileAtomically(configPath, '');
  }

  restoreCliLoginBackup(): void {
    const backupPath = path.join(this.codexDir, 'config.toml.cli_backup');
    if (!fs.existsSync(backupPath)) {
      return;
    }
    this.ensureCodexDir();
    fs.copyFileSync(backupPath, this.configTomlPath());
    fs.rmSync(backupPath, { force: true });
  }

  private configTomlPath(): string {
    return path.join(this.codexDir, 'config.toml');
  }

  private authJsonPath(): string {
    return path.join(this.codexDir, 'auth.json');
  }

  private readText(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private ensureCodexDir(): void {
    fs.mkdirSync(this.codexDir, { recursive: true });
  }

  private writeFileAtomically(filePath: string, content: string): void {
    this.ensureCodexDir();
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `${path.basename(filePath)}-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
    }
  }
}
