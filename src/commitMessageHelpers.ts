const MAX_DIFF_LENGTH = 4000;
const COMMIT_TAG_START = '<commit>';
const COMMIT_TAG_END = '</commit>';

const BUILTIN_COMMIT_PROMPT = `你是一个专门负责 GitHub commit 的高级程序员，请你遵循下面内容，生成高质量 commit

## 核心规则

### 基本格式
\`\`\`
<type>[scope]: <description>

[body]

[footer]
\`\`\`

### 输出要求
- 只输出提交消息，不添加签名、标记或元信息
- 不要包含 "Generated with Claude Code"、"Co-Authored-By" 等内容
- 不使用 emoji（除非项目规范明确要求）
- 使用祈使语气、现在时（"add" 而非 "added"）
- 主题行不超过 72 字符
- 保持简洁专业
- **必须用 \`<commit></commit>\` 标签包裹，标签外不要有任何内容**
- 语言默认使用英文
- **type/scope 冒号后必须有一个空格**（正确：\`feat: add login\`，错误：\`feat:add login\`）
- **单词之间必须有空格**，禁止把多个变更粘成无空格长串
- 多条独立变更：主题只写一句概括，细节放到 body 分点列表，不要用连字符硬拼进主题行

## 提交类型映射

| Type | 描述 | 使用场景 |
|------|------|---------|
| \`feat\` | 新功能 | 添加新功能 |
| \`fix\` | Bug修复 | 修复问题 |
| \`docs\` | 文档 | 仅文档变更 |
| \`style\` | 代码风格 | 格式化、缺少分号等 |
| \`refactor\` | 重构 | 既不修复bug也不添加功能 |
| \`perf\` | 性能优化 | 性能改进 |
| \`test\` | 测试 | 添加或修改测试 |
| \`chore\` | 构建/工具 | 构建过程或工具变更 |
| \`ci\` | CI/CD | CI配置变更 |
| \`build\` | 构建系统 | 影响构建系统的变更 |
| \`revert\` | 回滚 | 回滚之前的提交 |

## Scope（范围）指南

Scope 应该是一个描述代码库部分的名词，在整个项目中保持一致，简短且有意义。

常见 Scope 示例：
- 模块级别：api, auth, ui, db, config, deps
- 组件级别：button, modal, header, footer
- 功能级别：parser, compiler, validator, router

## Body（正文）编写指南

Body 应该：
- 解释**是什么**变更和**为什么**变更（而不是如何变更）
- 使用项目符号列出多个变更
- 包含变更的动机
- 对比新旧行为
- 引用相关问题或决策
- 每行不超过 72 个字符

## Footer（页脚）编写指南

Footer 包含：
- Breaking Changes：BREAKING CHANGE: rename config.auth to config.authentication
- Issue 引用：Closes: #123, #124 / Fixes: #125 / Refs: #126

## 最佳实践

### 应该做的
- 使用现在时、祈使语气（"add" 而不是 "added"）
- 第一行保持在 50 个字符以内（最多 72）
- 描述的首字母大写
- 主题行末尾不加句号
- 主题和正文之间用空行分隔
- 使用正文解释是什么和为什么（而不是如何）
- 引用相关 issue 和破坏性变更

### 不应该做的
- 在一个提交中混合多个逻辑变更
- 在主题中包含实现细节
- 使用过去时（"added" 而不是 "add"）
- 创建过大的提交（难以审查）
- 提交损坏的代码（除非是 WIP）
- 包含敏感信息`;

export function buildCommitPrompt(diff: string, userAdditionalPrompt = '', projectAdditionalPrompt = ''): string {
  const prompt: string[] = [BUILTIN_COMMIT_PROMPT];

  if (userAdditionalPrompt.trim()) {
    prompt.push([
      '## 用户附加要求（优先遵循）',
      '',
      '以下是用户的额外要求，请在生成 commit message 时优先考虑这些要求：',
      '',
      userAdditionalPrompt.trim(),
    ].join('\n'));
  }

  if (projectAdditionalPrompt.trim()) {
    prompt.push([
      '## 项目专属要求',
      '',
      '以下是当前项目的专属要求，与上述用户附加要求同时生效。当两者矛盾时，以此处项目要求为准：',
      '',
      projectAdditionalPrompt.trim(),
    ].join('\n'));
  }

  prompt.push([
    '---',
    '',
    '以下是 git diff 信息，请根据以上规则生成 commit message：',
    '',
    '```diff',
    truncateDiff(diff),
    '```',
    '',
    '【输出格式要求 - 必须严格遵守】',
    '请将 commit message 用 XML 标签包裹输出，格式如下：',
    '<commit>',
    'type(scope): description',
    '',
    'optional body',
    '</commit>',
    '',
    '重要规则：',
    '1. 必须使用 <commit> 和 </commit> 标签包裹',
    '2. 标签外不要有任何其他内容（不要分析、不要解释、不要说明）',
    '3. 冒号后必须有空格；单词之间必须有空格',
  ].join('\n'));

  return prompt.join('\n\n');
}

export function cleanupCommitMessage(message: string | null | undefined): string {
  if (!message) {
    return '';
  }

  const cleaned = removeThinkingMarkers(message);
  const startIdx = cleaned.indexOf(COMMIT_TAG_START);
  const endIdx = cleaned.indexOf(COMMIT_TAG_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return normalizeCommitMessage(
      convertLiteralNewlines(cleaned.slice(startIdx + COMMIT_TAG_START.length, endIdx).trim()),
    );
  }

  if (cleaned.includes('```')) {
    const codeBlockStart = cleaned.indexOf('```');
    const contentStart = cleaned.indexOf('\n', codeBlockStart);
    if (contentStart !== -1) {
      const codeBlockEnd = cleaned.indexOf('```', contentStart);
      if (codeBlockEnd !== -1) {
        return normalizeCommitMessage(
          convertLiteralNewlines(cleaned.slice(contentStart + 1, codeBlockEnd).trim()),
        );
      }
    }
  }

  const lines = cleaned.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!isConventionalCommitLine(line) && !isLooseConventionalCommitLine(line)) {
      continue;
    }

    const result = [line];
    let inBody = false;
    for (let i = idx + 1; i < lines.length; i++) {
      const nextLine = lines[i].trim();
      if (isAnalysisSection(nextLine)) {
        break;
      }
      if (!nextLine) {
        inBody = true;
        result.push('');
        continue;
      }
      if (inBody && !nextLine.startsWith('#') && !nextLine.startsWith('*')) {
        result.push(nextLine);
      } else if (!inBody) {
        break;
      }
    }
    return normalizeCommitMessage(convertLiteralNewlines(result.join('\n').trim()));
  }

  const fallback: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (isAnalysisSection(trimmed)) {
      break;
    }
    if (trimmed) {
      fallback.push(trimmed);
    }
    if (fallback.length >= 5) {
      break;
    }
  }

  return normalizeCommitMessage(convertLiteralNewlines(fallback.join('\n').trim()));
}

/**
 * Repair common model / streaming artifacts in conventional commit text.
 * - ensure space after `type:` / `type(scope):`
 * - split hyphen-glued multi-change subjects into subject + body bullets
 */
export function normalizeCommitMessage(message: string): string {
  if (!message) {
    return '';
  }

  const text = convertLiteralNewlines(message).trim();
  if (!text) {
    return '';
  }

  const lines = text.split('\n');
  const subjectRaw = lines[0]?.trim() ?? '';
  const rest = lines.slice(1);

  const match = subjectRaw.match(
    /^(feat|fix|refactor|docs|test|chore|perf|ci|style|build|revert)(\([^)]+\))?(!)?:\s*(.*)$/i,
  );
  if (!match) {
    return text;
  }

  const type = match[1].toLowerCase();
  const scope = match[2] ?? '';
  const breaking = match[3] ?? '';
  let description = (match[4] ?? '').trim();

  // Hyphen-glued multi-change dump: "RefreshFoo-RewordBar-KeepBaz"
  const hyphenParts = description
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean);
  const looksGlued =
    hyphenParts.length >= 2
    && !description.includes(' ')
    && hyphenParts.every((part) => /^[A-Za-z]/.test(part) && part.length >= 4);

  let bodyFromSubject: string[] = [];
  if (looksGlued) {
    description = humanizeGluedSegment(hyphenParts[0]);
    bodyFromSubject = hyphenParts.slice(1).map((part) => `- ${humanizeGluedSegment(part)}`);
  } else {
    description = softSpaceCamelCase(description);
  }

  // Cap extremely long subjects after repair
  if (description.length > 72) {
    const cut = description.slice(0, 72);
    const lastSpace = cut.lastIndexOf(' ');
    description = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }

  const subject = `${type}${scope}${breaking}: ${description}`.replace(/:\s+/, ': ').trim();
  const bodyLines = [...bodyFromSubject, ...rest.map((line) => line.trimEnd())]
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return bodyLines ? `${subject}\n\n${bodyLines}` : subject;
}

/** "Refreshcommentsandeditorstate" → keep as-is if no camelCase cues; soft-split camelCase. */
function humanizeGluedSegment(segment: string): string {
  const spaced = softSpaceCamelCase(segment);
  // Prefer sentence case for bullet/subject fragments that start with a capital run
  if (/^[A-Z]/.test(spaced)) {
    return spaced.charAt(0).toLowerCase() + spaced.slice(1);
  }
  return spaced;
}

function softSpaceCamelCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function getUserAdditionalPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed === '你是一个commit提交专员，请你阅读git记录，帮我生成commit记录') {
    return '';
  }
  return trimmed;
}

export function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_LENGTH) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_LENGTH)}\n... (diff 过长，已截断)`;
}

function convertLiteralNewlines(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isConventionalCommitLine(line: string): boolean {
  return /^(feat|fix|refactor|docs|test|chore|perf|ci|style|build|revert)(\([^)]+\))?!?:\s+\S/.test(line);
}

/** Accepts `chore:Foo` (missing space) so cleanup can still recover it. */
function isLooseConventionalCommitLine(line: string): boolean {
  return /^(feat|fix|refactor|docs|test|chore|perf|ci|style|build|revert)(\([^)]+\))?!?:\S/.test(line);
}

function isAnalysisSection(line: string): boolean {
  if (!line) {
    return false;
  }
  const keywords = [
    '分析说明', '变更特征', '分析：', '说明：', '解释：', '备注：',
    'Analysis:', 'Explanation:', 'Note:', '---', '===',
    '1. 类型', '2. Scope', '3. 描述', '4. Body',
    '• ', '- 无需', '- 不涉及',
  ];
  return keywords.some((keyword) => line.includes(keyword)) || /^\d+\.\s+.*$/.test(line);
}

function removeThinkingMarkers(message: string): string {
  return message
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^Thinking\s*>.*$/gmi, '')
    .trim();
}
