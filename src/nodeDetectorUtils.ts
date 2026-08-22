import * as path from 'path';

export function isLikelyNodeExecutable(filePath: string, platform = process.platform): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (platform === 'win32') {
    return base === 'node.exe' || base === 'node';
  }
  return base === 'node';
}

export function getNodeBinaryNames(platform = process.platform): string[] {
  return platform === 'win32' ? ['node.exe', 'node'] : ['node'];
}

export function getNpmBinaryNames(platform = process.platform): string[] {
  return platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
}

export function getNpmCandidatesFromNodePath(nodePath: string, platform = process.platform): string[] {
  return getNpmBinaryNames(platform).map((name) => path.join(path.dirname(nodePath), name));
}

export function getCommonNodeCandidates(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA;
    const candidates = [
      path.join(programFiles, 'nodejs', 'node.exe'),
      path.join(programFiles, 'nodejs', 'node'),
      path.join(programFilesX86, 'nodejs', 'node.exe'),
      path.join(programFilesX86, 'nodejs', 'node'),
    ];
    if (localAppData) {
      candidates.push(
        path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
        path.join(localAppData, 'Programs', 'nodejs', 'node'),
      );
    }
    return candidates;
  }

  return [
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
    '/opt/homebrew/opt/node/bin/node',
  ];
}

export function getCommonNpmCandidates(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA;
    const candidates = [
      path.join(programFiles, 'nodejs', 'npm.cmd'),
      path.join(programFiles, 'nodejs', 'npm'),
      path.join(programFilesX86, 'nodejs', 'npm.cmd'),
      path.join(programFilesX86, 'nodejs', 'npm'),
    ];
    if (localAppData) {
      candidates.push(
        path.join(localAppData, 'Programs', 'nodejs', 'npm.cmd'),
        path.join(localAppData, 'Programs', 'nodejs', 'npm'),
      );
    }
    return candidates;
  }

  return [
    '/usr/local/bin/npm',
    '/usr/bin/npm',
    '/opt/homebrew/bin/npm',
    '/opt/homebrew/opt/node/bin/npm',
  ];
}
