import * as fs from 'fs';
import * as path from 'path';

/**
 * Codex skill toggle path validation (vscode-free, unit-testable).
 *
 * Mirrors the JetBrains `CodexSkillService.isToggleSkillPathAllowed`: a toggle
 * target must be an existing, non-symlink SKILL.md/skill.md whose real path
 * lives inside one of the configured skill scan directories. This keeps a
 * crafted `skillPath` from writing `[[skills.config]]` entries for arbitrary
 * files into ~/.codex/config.toml.
 */
export function isToggleSkillPathAllowed(skillPath: string, scanDirs: string[]): boolean {
  if (!skillPath) {
    return false;
  }
  try {
    const candidate = path.resolve(skillPath);
    const fileName = path.basename(candidate);
    if (fileName !== 'SKILL.md' && fileName !== 'skill.md') {
      return false;
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }

    const realCandidate = fs.realpathSync(candidate);
    for (const scanDir of scanDirs) {
      if (!scanDir) continue;
      try {
        const root = path.resolve(scanDir);
        if (!fs.statSync(root).isDirectory()) continue;
        const realRoot = fs.realpathSync(root);
        if (realCandidate.startsWith(realRoot + path.sep)) {
          return true;
        }
      } catch {
        // Unreadable scan roots cannot authorize anything.
      }
    }
  } catch {
    return false;
  }
  return false;
}
