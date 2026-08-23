/**
 * Extracts `tools.update_plan(...)` snapshots from Codex Responses API `exec`
 * custom_tool_call scripts without evaluating JavaScript, plus the shared
 * update_plan input normalization. TS port of the ai-bridge
 * codex-plan-parser.js / codex-tool-normalization.js helpers so the history
 * transform can replay plans exactly like the live event stream does.
 */

const UPDATE_PLAN_TOKEN = 'tools.update_plan';
const INVALID = Symbol('invalid-js-literal');

type JsLiteral = string | number | boolean | null | undefined | JsLiteral[] | { [key: string]: JsLiteral };

function isIdentifierStart(char: string | undefined): boolean {
  return /[A-Za-z_$]/.test(char ?? '');
}

function isIdentifierPart(char: string | undefined): boolean {
  return /[A-Za-z0-9_$]/.test(char ?? '');
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    const current = source[cursor++];
    if (current === '\\' && cursor < source.length) {
      cursor += 1;
    } else if (current === quote) {
      break;
    }
  }
  return cursor;
}

function skipTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const lineEnd = source.indexOf('\n', cursor + 2);
      cursor = lineEnd >= 0 ? lineEnd + 1 : source.length;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const blockEnd = source.indexOf('*/', cursor + 2);
      cursor = blockEnd >= 0 ? blockEnd + 2 : source.length;
      continue;
    }
    break;
  }
  return cursor;
}

function findToken(source: string, token: string, start: number): number {
  let cursor = Math.max(0, start);
  while (cursor < source.length) {
    const current = source[cursor];
    if (current === '"' || current === "'" || current === '`') {
      cursor = skipString(source, cursor);
      continue;
    }
    if (source.startsWith('//', cursor) || source.startsWith('/*', cursor)) {
      cursor = skipTrivia(source, cursor);
      continue;
    }
    if (source.startsWith(token, cursor)) {
      const before = cursor > 0 ? source[cursor - 1] : '';
      const after = source[cursor + token.length] ?? '';
      if (!isIdentifierPart(before) && before !== '.' && !isIdentifierPart(after)) {
        return cursor;
      }
    }
    cursor += 1;
  }
  return -1;
}

function parseJavaScriptLiteral(source: string, start: number): { value: JsLiteral; nextIndex: number } | null {
  let cursor = start;

  function parseStringLiteral(): string | typeof INVALID {
    const quote = source[cursor++];
    let value = '';
    while (cursor < source.length) {
      const current = source[cursor++];
      if (current === quote) return value;
      if (quote === '`' && current === '$' && source[cursor] === '{') return INVALID;
      if (current !== '\\' || cursor >= source.length) {
        value += current;
        continue;
      }

      const escaped = source[cursor++];
      const simpleEscapes: Record<string, string> = {
        b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0',
      };
      if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
      } else if (escaped === 'x' || escaped === 'u') {
        const length = escaped === 'x' ? 2 : 4;
        const hex = source.slice(cursor, cursor + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return INVALID;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += length;
      } else if (escaped === '\r') {
        if (source[cursor] === '\n') cursor += 1;
      } else if (escaped !== '\n') {
        value += escaped;
      }
    }
    return INVALID;
  }

  function parseIdentifier(): string | typeof INVALID {
    if (!isIdentifierStart(source[cursor])) return INVALID;
    const startIndex = cursor++;
    while (isIdentifierPart(source[cursor])) cursor += 1;
    return source.slice(startIndex, cursor);
  }

  function parseArray(): JsLiteral[] | typeof INVALID {
    const values: JsLiteral[] = [];
    cursor += 1;
    while (cursor < source.length) {
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ']') {
        cursor += 1;
        return values;
      }
      const value = parseValue();
      if (value === INVALID) return INVALID;
      values.push(value);
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (source[cursor] !== ']') return INVALID;
    }
    return INVALID;
  }

  function parseObject(): { [key: string]: JsLiteral } | typeof INVALID {
    const value: { [key: string]: JsLiteral } = Object.create(null);
    cursor += 1;
    while (cursor < source.length) {
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === '}') {
        cursor += 1;
        return value;
      }

      const key = source[cursor] === '"' || source[cursor] === "'" || source[cursor] === '`'
        ? parseStringLiteral()
        : parseIdentifier();
      if (key === INVALID || typeof key !== 'string') return INVALID;
      cursor = skipTrivia(source, cursor);
      if (source[cursor] !== ':') return INVALID;
      cursor = skipTrivia(source, cursor + 1);
      const propertyValue = parseValue();
      if (propertyValue === INVALID) return INVALID;
      value[key] = propertyValue;
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (source[cursor] !== '}') return INVALID;
    }
    return INVALID;
  }

  function parseValue(): JsLiteral | typeof INVALID {
    cursor = skipTrivia(source, cursor);
    const current = source[cursor];
    if (current === '"' || current === "'" || current === '`') return parseStringLiteral();
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();

    const numberMatch = source.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      cursor += numberMatch[0].length;
      return Number(numberMatch[0]);
    }

    const identifier = parseIdentifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    if (identifier === 'undefined') return undefined;
    return INVALID;
  }

  const value = parseValue();
  return value === INVALID ? null : { value, nextIndex: cursor };
}

function extractSource(payload: Record<string, any>): string {
  if (typeof payload?.input === 'string') return payload.input;
  if (payload?.input && typeof payload.input === 'object' && typeof payload.input.code === 'string') {
    return payload.input.code;
  }
  return '';
}

export function normalizePlanStatus(status: unknown): string {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

export function normalizeUpdatePlanInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  const plan = Array.isArray(normalized.plan) ? normalized.plan : [];
  normalized.plan = plan
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const content =
        (typeof row.content === 'string' && row.content.trim()) ? row.content.trim() :
        (typeof row.step === 'string' && row.step.trim()) ? row.step.trim() :
        (typeof row.title === 'string' && row.title.trim()) ? row.title.trim() :
        (typeof row.text === 'string' && row.text.trim()) ? row.text.trim() :
        '';
      if (!content) return null;
      return {
        ...row,
        content,
        step: content,
        status: normalizePlanStatus(row.status),
      };
    })
    .filter(Boolean);
  return normalized;
}

export function extractUpdatePlanFromResponseItemPayload(
  payload: Record<string, any>,
): Record<string, unknown> | null {
  if (!payload || payload.type !== 'custom_tool_call') return null;
  if (String(payload.name || '').toLowerCase() !== 'exec') return null;

  const source = extractSource(payload);
  if (!source) return null;

  let searchStart = 0;
  let latestPlan: Record<string, unknown> | null = null;
  while (searchStart < source.length) {
    const callStart = findToken(source, UPDATE_PLAN_TOKEN, searchStart);
    if (callStart < 0) break;
    let cursor = skipTrivia(source, callStart + UPDATE_PLAN_TOKEN.length);
    if (source[cursor] === '(') {
      latestPlan = null;
      cursor = skipTrivia(source, cursor + 1);
      const parsed = parseJavaScriptLiteral(source, cursor);
      if (parsed?.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
          && Array.isArray((parsed.value as Record<string, JsLiteral>).plan)) {
        latestPlan = normalizeUpdatePlanInput(parsed.value as Record<string, unknown>);
      }
    }
    searchStart = callStart + UPDATE_PLAN_TOKEN.length;
  }
  return latestPlan;
}
