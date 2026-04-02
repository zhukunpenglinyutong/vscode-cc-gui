import { describe, expect, it } from 'vitest';
import { extractFilePathFromCommand, isFileViewingCommand, parseCommandType } from './toolCommandPath';

describe('toolCommandPath', () => {
  it('extracts a sed target from grouped commands', () => {
    const command = "sed -n '1,220p' src/main/java/com/github/claudecodegui/dependency/NpmPermissionHelper.java && printf '\\n---\\n' && sed -n '1,220p' src/main/java/com/github/claudecodegui/dependency/SdkDefinition.java";

    expect(extractFilePathFromCommand(command)).toBe(
      'src/main/java/com/github/claudecodegui/dependency/NpmPermissionHelper.java:1-220',
    );
  });

  it('extracts a path from shell-wrapped grouped commands', () => {
    const command = "/bin/bash -lc '(sed -n '\\''230,430p'\\'' src/main/java/com/github/claudecodegui/dependency/DependencyManager.java && printf '\\''\\n---\\n'\\'' && sed -n '\\''260,340p'\\'' src/main/java/com/github/claudecodegui/handler/DependencyHandler.java)'";

    expect(extractFilePathFromCommand(command)).toBe(
      'src/main/java/com/github/claudecodegui/dependency/DependencyManager.java:230-430',
    );
  });

  it('extracts the first readable file from a pipeline', () => {
    expect(extractFilePathFromCommand('cat README.md | head -n 20')).toBe('README.md');
  });

  it('detects file viewing commands through wrappers', () => {
    const command = "/bin/zsh -lc 'cd /tmp && sed -n \"10,20p\" src/App.tsx && printf \"done\"'";

    expect(isFileViewingCommand(command)).toBe(true);
    expect(extractFilePathFromCommand(command, '/tmp')).toBe('src/App.tsx:10-20');
  });

  describe('parseCommandType', () => {
    it('identifies read commands (cat, head, tail, nl)', () => {
      expect(parseCommandType('cat file.txt').type).toBe('read');
      expect(parseCommandType('head -n 20 file.txt').type).toBe('read');
      expect(parseCommandType('tail -n 50 file.txt').type).toBe('read');
      expect(parseCommandType('nl -ba file.txt').type).toBe('read');
      expect(parseCommandType('sed -n "1,100p" file.txt').type).toBe('read');
    });

    it('identifies list commands (ls, tree)', () => {
      expect(parseCommandType('ls -la').type).toBe('list');
      expect(parseCommandType('ls src/').type).toBe('list');
      expect(parseCommandType('tree -L 2').type).toBe('list');
    });

    it('identifies search commands (grep, rg)', () => {
      expect(parseCommandType('grep -r "pattern" src/').type).toBe('search');
      expect(parseCommandType('rg "TODO" .').type).toBe('search');
    });

    it('returns unknown for other commands', () => {
      expect(parseCommandType('git status').type).toBe('unknown');
      expect(parseCommandType('npm run build').type).toBe('unknown');
      expect(parseCommandType('echo hello').type).toBe('unknown');
    });

    it('extracts path for read commands', () => {
      const result = parseCommandType('cat src/main.ts');
      expect(result.type).toBe('read');
      expect(result.path).toBe('src/main.ts');
    });

    it('identifies multi-file sed commands as read', () => {
      const command = "sed -n '240,420p' src/main/java/com/github/claudecodegui/handler/DependencyHandler.java && sed -n '420,760p' src/main/java/com/github/claudecodegui/bridge/NodeDetector.java";
      const result = parseCommandType(command);
      expect(result.type).toBe('read');
      expect(result.path).toBe('src/main/java/com/github/claudecodegui/handler/DependencyHandler.java:240-420');
    });

    it('extracts clean file name from path with line numbers', () => {
      const command = "sed -n '240,420p' src/main/java/com/example/File.java";
      const result = parseCommandType(command);
      expect(result.type).toBe('read');
      // Should extract file name: File.java
      const path = result.path;
      const fileName = path?.split('/').pop()?.split(':')[0];
      expect(fileName).toBe('File.java');
    });

    it('handles user-provided multi-sed command', () => {
      const command = "sed -n '240,420p' src/main/java/com/github/claudecodegui/handler/DependencyHandler.java && sed -n '420,760p' src/main/java/com/github/claudecodegui/bridge/NodeDetector.java && sed -n '460,620p' src/main/java/com/github/claudecodegui/dependency/DependencyManager.java && sed -n '130,260p' webview/src/components/settings/DependencySection/index.tsx && sed -n '1,260p' webview/src/components/settings/hooks/useSettingsWindowCallbacks.ts";

      // Should identify as read type
      const result = parseCommandType(command);
      expect(result.type).toBe('read');

      // Should extract first file path
      expect(result.path).toBe('src/main/java/com/github/claudecodegui/handler/DependencyHandler.java:240-420');

      // Extract clean file name for display
      const fileName = result.path?.split('/').pop()?.split(':')[0];
      expect(fileName).toBe('DependencyHandler.java');
    });

    it('handles nl piped to sed commands', () => {
      const command = "nl -ba src/main/java/com/example/File.java | sed -n '1,100p'";
      const result = parseCommandType(command);
      expect(result.type).toBe('read');
      expect(result.path).toBe('src/main/java/com/example/File.java');

      // Extract clean file name
      const fileName = result.path?.split('/').pop();
      expect(fileName).toBe('File.java');
    });

    it('handles nl with line numbers piped to sed', () => {
      const command = "nl -ba webview/src/components/toolBlocks/EditToolBlock.tsx | sed -n '1,260p'";
      const result = parseCommandType(command);
      expect(result.type).toBe('read');
      expect(result.path).toBe('webview/src/components/toolBlocks/EditToolBlock.tsx');

      const fileName = result.path?.split('/').pop();
      expect(fileName).toBe('EditToolBlock.tsx');
    });

    it('extracts clean file name without line numbers', () => {
      const command = "sed -n '240,420p' src/main/java/com/example/MyFile.java";
      const result = parseCommandType(command);
      expect(result.type).toBe('read');
      expect(result.path).toBe('src/main/java/com/example/MyFile.java:240-420');

      // Clean file name should not contain line numbers
      const fileName = result.path?.split('/').pop()?.split(':')[0];
      expect(fileName).toBe('MyFile.java');
    });
  });
});
