import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import {
  getCommonNodeCandidates,
  getCommonNpmCandidates,
  getNpmCandidatesFromNodePath,
  isLikelyNodeExecutable,
} from './nodeDetectorUtils';

/**
 * Resolve the Node binary used by CC GUI (daemon / SDK).
 * Order: user setting → common install paths → PATH (`which` / `where`).
 * No multi-version manager scanning — if the resolved Node is too old,
 * the UI asks the user to install Node 20+ separately and paste the path.
 */
export class NodeDetector {
  static find(context: vscode.ExtensionContext): string | undefined {
    const config = vscode.workspace.getConfiguration('ccGui');
    const customPath = (config.get<string>('nodePath') ?? '').trim();
    if (customPath && fs.existsSync(customPath) && isLikelyNodeExecutable(customPath)) {
      return customPath;
    }

    const candidates = [
      ...getCommonNodeCandidates(process.platform, process.env),
      ...(isLikelyNodeExecutable(process.execPath) ? [process.execPath] : []),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c) && isLikelyNodeExecutable(c)) return c;
    }

    try {
      const lookup = process.platform === 'win32' ? 'where node' : 'which node';
      const result = cp.execSync(lookup, { encoding: 'utf8' }).trim();
      const first = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && fs.existsSync(first) && isLikelyNodeExecutable(first)) return first;
    } catch {
      /* ignore */
    }

    return undefined;
  }

  static findNpm(context: vscode.ExtensionContext): string | undefined {
    const nodePath = NodeDetector.find(context);
    if (nodePath) {
      for (const npmPath of getNpmCandidatesFromNodePath(nodePath, process.platform)) {
        if (fs.existsSync(npmPath)) return npmPath;
      }
    }

    const candidates = getCommonNpmCandidates(process.platform, process.env);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    try {
      const lookup = process.platform === 'win32' ? 'where npm' : 'which npm';
      const result = cp.execSync(lookup, { encoding: 'utf8', timeout: 5000 }).trim();
      const first = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch {
      /* ignore */
    }

    return undefined;
  }
}
