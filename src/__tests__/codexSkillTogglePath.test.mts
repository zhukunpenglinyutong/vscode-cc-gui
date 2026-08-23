import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { isToggleSkillPathAllowed } = await import('../bridge/handlers/codexSkillTogglePath.ts');

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-toggle-path-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSkill(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: review\n---\n# review\n');
  return file;
}

describe('isToggleSkillPathAllowed', () => {
  it('accepts an existing SKILL.md inside a configured scan directory', () => {
    const scanDir = path.join(root, '.agents', 'skills');
    const skillFile = writeSkill(path.join(scanDir, 'review'));
    assert.equal(isToggleSkillPathAllowed(skillFile, [scanDir]), true);
  });

  it('rejects a SKILL.md outside every configured scan directory', () => {
    const scanDir = path.join(root, '.agents', 'skills');
    fs.mkdirSync(scanDir, { recursive: true });
    const outsideFile = writeSkill(path.join(root, 'outside'));
    assert.equal(isToggleSkillPathAllowed(outsideFile, [scanDir]), false);
  });

  it('rejects a missing SKILL.md inside a configured scan directory', () => {
    const scanDir = path.join(root, '.agents', 'skills');
    const missing = path.join(scanDir, 'missing', 'SKILL.md');
    assert.equal(isToggleSkillPathAllowed(missing, [scanDir]), false);
  });

  it('rejects non-SKILL.md file names and empty paths', () => {
    const scanDir = path.join(root, '.agents', 'skills');
    const notSkill = path.join(scanDir, 'review', 'README.md');
    fs.mkdirSync(path.dirname(notSkill), { recursive: true });
    fs.writeFileSync(notSkill, '# nope\n');
    assert.equal(isToggleSkillPathAllowed(notSkill, [scanDir]), false);
    assert.equal(isToggleSkillPathAllowed('', [scanDir]), false);
  });

  it('rejects a symlink SKILL.md even inside a scan directory', () => {
    const scanDir = path.join(root, 'linked-skills');
    const target = writeSkill(path.join(root, 'real-target'));
    fs.mkdirSync(scanDir, { recursive: true });
    const link = path.join(scanDir, 'SKILL.md');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // platform without symlink permission — nothing to assert
    }
    assert.equal(isToggleSkillPathAllowed(link, [scanDir]), false);
  });
});
