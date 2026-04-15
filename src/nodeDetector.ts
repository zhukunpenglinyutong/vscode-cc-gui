import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export class NodeDetector {
  static find(context: vscode.ExtensionContext): string | undefined {
    // 1. User config
    const config = vscode.workspace.getConfiguration('claudeCodeGui');
    const customPath = config.get<string>('nodePath');
    if (customPath && fs.existsSync(customPath)) return customPath;

    // 2. Common locations
    const candidates = [
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/bin/node',
      process.execPath, // VSCode's own node
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // 3. PATH lookup
    try {
      const result = cp.execSync('which node', { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* ignore */ }

    return undefined;
  }
}
