import * as fs from 'fs';
import { codexImageTagRegex, imagePathFromCodexImageTagMatch } from './codexImageTags.ts';

export interface CodexHistoryImageLoader {
  imageBlockFromLocalPath(filePath: string): Record<string, unknown> | null;
}

export interface CodexHistoryTransformOptions {
  storedUserInputs?: string[];
  shouldApplyStoredUserInput?: (rawText: string) => boolean;
  normalizeUserDisplayText?: (rawText: string) => string;
}

export interface CodexHistorySummary {
  sessionId: string;
  firstUserText: string;
  messageCount: number;
  lastTimestamp: string;
  cwd?: string;
}

type CodexJsonlRow = Record<string, any>;
type CodexPayload = Record<string, any>;
type PendingUserImageBlocks = {
  blocks: Array<Record<string, unknown>>;
  text: string;
};

export function transformCodexHistoryRows(
  rows: CodexJsonlRow[],
  imageLoader: CodexHistoryImageLoader,
  options: CodexHistoryTransformOptions = {},
): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  const storedUserInputs = Array.isArray(options.storedUserInputs) ? options.storedUserInputs : [];
  let storedUserInputIndex = 0;
  // Buffer for user-turn image blocks that Codex writes to `response_item / message / role:user`
  // rows. They are attached to the next `event_msg / user_message` row (which carries the text).
  let pendingUserImageBlocks: PendingUserImageBlocks | null = null;
  let lastUserMessageWithoutImagesIndex = -1;

  const flushPendingImagesToPreviousUser = () => {
    if (!pendingUserImageBlocks || lastUserMessageWithoutImagesIndex < 0) return;
    prependBlocksToUserMessage(messages[lastUserMessageWithoutImagesIndex], pendingUserImageBlocks.blocks);
    pendingUserImageBlocks = null;
    lastUserMessageWithoutImagesIndex = -1;
  };

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();

    if (row.type === 'event_msg') {
      const payload = row.payload as CodexPayload | undefined;
      if (!payload || payload.type !== 'user_message') continue;
      const blocks = convertCodexEventUserMessage(payload, imageLoader);
      if (blocks.length === 0) continue;

      const rawText = extractTextFromBlocks(blocks);

      // Codex may write the user turn as response_item(input_image/input_text)
      // immediately before event_msg(user_message). Match the text so those
      // images attach to the same user turn, not the previous text-only turn.
      if (pendingUserImageBlocks) {
        const pendingText = pendingUserImageBlocks.text.trim();
        if (!pendingText || pendingText === rawText.trim()) {
          blocks.splice(0, blocks.length, ...dedupeContentBlocks([
            ...pendingUserImageBlocks.blocks,
            ...blocks,
          ]));
          pendingUserImageBlocks = null;
        } else {
          flushPendingImagesToPreviousUser();
        }
      }

      let displayText = rawText;
      if (
        storedUserInputIndex < storedUserInputs.length &&
        (options.shouldApplyStoredUserInput?.(rawText) ?? true)
      ) {
        const typed = String(storedUserInputs[storedUserInputIndex++] ?? '').trim();
        if (typed) displayText = typed;
      } else if (options.normalizeUserDisplayText) {
        displayText = options.normalizeUserDisplayText(rawText);
      }

      const hasVisibleNonTextBlock = blocks.some((block) => block.type !== 'text');
      if (!displayText && !hasVisibleNonTextBlock) {
        continue;
      }

      const finalBlocks = displayText !== rawText
        ? replaceTextBlocks(blocks, displayText)
        : blocks;

      messages.push({
        type: 'user',
        content: displayText,
        raw: { message: { role: 'user', content: finalBlocks } },
        timestamp,
      });
      lastUserMessageWithoutImagesIndex = finalBlocks.some((block) => block.type === 'image')
        ? -1
        : messages.length - 1;
      continue;
    }

    if (row.type !== 'response_item') continue;

    const payload = row.payload as CodexPayload | undefined;
    if (!payload || typeof payload !== 'object') continue;
    const payloadType = typeof payload.type === 'string' ? payload.type : '';

    if (payloadType === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : '';
      // Buffer user-role image blocks for attachment to the next event_msg/user_message.
      // Codex splits a user turn: text goes to event_msg, images go to response_item.
      // We only pick `input_image` blocks here — the `input_text` block echoes the same
      // image as `<image path="...">` XML, which would double-count if also processed.
      if (role === 'user') {
        const rawContent = Array.isArray(payload.content) ? payload.content : [];
        const imageBlocks: Array<Record<string, unknown>> = [];
        for (const entry of rawContent) {
          if (!entry || typeof entry !== 'object') continue;
          const candidate = entry as Record<string, any>;
          if (candidate.type !== 'input_image') continue;
          const pathLike = typeof candidate.path === 'string' ? candidate.path
            : typeof candidate.file_path === 'string' ? candidate.file_path : '';
          const imageBlock = pathLike
            ? imageLoader.imageBlockFromLocalPath(pathLike)
            : imageBlockFromDataUrl(candidate.image_url);
          if (imageBlock) imageBlocks.push(imageBlock);
        }
        if (imageBlocks.length > 0) {
          if (pendingUserImageBlocks) flushPendingImagesToPreviousUser();
          pendingUserImageBlocks = {
            blocks: imageBlocks,
            text: extractCodexResponseUserText(rawContent),
          };
        }
        continue;
      }
      if (role !== 'assistant') continue;
      const blocks = convertCodexMessageContent(payload.content, imageLoader);
      if (blocks.length === 0) continue;
      messages.push({
        type: 'assistant',
        content: extractTextFromBlocks(blocks),
        raw: { message: { role: 'assistant', content: blocks } },
        timestamp,
      });
      continue;
    }

    if (payloadType === 'reasoning') {
      const blocks = convertCodexReasoningPayload(payload);
      if (blocks.length === 0) continue;
      messages.push({
        type: 'assistant',
        content: extractTextFromBlocks(blocks),
        raw: { message: { role: 'assistant', content: blocks } },
        timestamp,
      });
      continue;
    }

    if (payloadType === 'function_call') {
      const block = convertCodexFunctionCallPayload(payload);
      if (!block) continue;
      messages.push({
        type: 'assistant',
        content: '[tool_use]',
        raw: { message: { role: 'assistant', content: [block] } },
        timestamp,
      });
      continue;
    }

    if (payloadType === 'function_call_output') {
      const block = convertCodexFunctionCallOutputPayload(payload);
      if (!block) continue;
      messages.push({
        type: 'user',
        content: '[tool_result]',
        raw: { message: { role: 'user', content: [block] } },
        timestamp,
      });
    }
  }

  flushPendingImagesToPreviousUser();
  return messages;
}

export function summarizeCodexHistoryRows(
  rows: CodexJsonlRow[],
  imageLoader: CodexHistoryImageLoader,
  options: CodexHistoryTransformOptions = {},
): CodexHistorySummary | null {
  let sessionId = '';
  let lastTimestamp = '';
  let cwd = '';

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.timestamp === 'string' && row.timestamp) {
      lastTimestamp = row.timestamp;
    }
    if (row.type === 'session_meta') {
      const payload = row.payload as CodexPayload | undefined;
      const candidate = payload?.session_id || payload?.id;
      if (typeof candidate === 'string' && candidate.trim()) {
        sessionId = candidate.trim();
      }
      if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
        cwd = payload.cwd.trim();
      }
    }
  }

  const messages = transformCodexHistoryRows(rows, imageLoader, options);
  if (!sessionId && messages.length === 0) return null;

  const firstUser = messages.find(
    (message) =>
      message.type === 'user' &&
      typeof message.content === 'string' &&
      message.content.trim() &&
      message.content.trim() !== '[tool_result]',
  );

  return {
    sessionId,
    firstUserText: firstUser?.content?.trim().slice(0, 80) ?? '',
    messageCount: messages.length,
    lastTimestamp: lastTimestamp || new Date().toISOString(),
    cwd: cwd || undefined,
  };
}

export function convertCodexMessageContent(
  content: unknown,
  imageLoader: CodexHistoryImageLoader,
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, any>;
    const type = typeof candidate.type === 'string' ? candidate.type : '';

    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = typeof candidate.text === 'string' ? candidate.text : '';
      blocks.push(...parseCodexTextAndImages(text, imageLoader));
      continue;
    }

    if (type === 'input_image') {
      const pathLike = typeof candidate.path === 'string' ? candidate.path : typeof candidate.file_path === 'string' ? candidate.file_path : '';
      if (pathLike) {
        const imageBlock = imageLoader.imageBlockFromLocalPath(pathLike);
        if (imageBlock) blocks.push(imageBlock);
        continue;
      }
      const imageBlock = imageBlockFromDataUrl(candidate.image_url);
      if (imageBlock) blocks.push(imageBlock);
      continue;
    }

    if (type === 'image') {
      if (candidate.source && typeof candidate.source === 'object') {
        blocks.push({ type: 'image', source: candidate.source });
        continue;
      }
      const imageBlock = imageBlockFromDataUrl(candidate.src);
      if (imageBlock) blocks.push(imageBlock);
      continue;
    }
  }

  return coalesceAdjacentTextBlocks(blocks);
}

function parseCodexTextAndImages(
  rawText: string,
  imageLoader: CodexHistoryImageLoader,
): Array<Record<string, unknown>> {
  const text = String(rawText || '');
  if (!text.trim()) return [];

  const blocks: Array<Record<string, unknown>> = [];
  const regex = codexImageTagRegex();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const cleanTextFragment = (value: string): string => value.replace(/<\/image>/gi, '').trim();

  while ((match = regex.exec(text)) !== null) {
    const before = cleanTextFragment(text.slice(lastIndex, match.index));
    if (before) {
      blocks.push({ type: 'text', text: before });
    }
    const imagePath = imagePathFromCodexImageTagMatch(match);
    const imageBlock = imagePath ? imageLoader.imageBlockFromLocalPath(imagePath) : null;
    if (imageBlock) {
      blocks.push(imageBlock);
    }
    lastIndex = regex.lastIndex;
  }

  const after = cleanTextFragment(text.slice(lastIndex));
  if (after) {
    blocks.push({ type: 'text', text: after });
  }

  return blocks;
}

function imageBlockFromDataUrl(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  };
}

function prependBlocksToUserMessage(
  message: Record<string, any> | undefined,
  blocks: Array<Record<string, unknown>>,
): void {
  if (!message || message.type !== 'user' || blocks.length === 0) return;
  const rawMessage = message.raw?.message;
  if (!rawMessage || typeof rawMessage !== 'object') return;
  const content = Array.isArray(rawMessage.content) ? rawMessage.content : [];
  rawMessage.content = dedupeContentBlocks([...blocks, ...content]);
}

function extractCodexResponseUserText(content: unknown[]): string {
  const textBlocks: Array<Record<string, unknown>> = [];
  const nullImageLoader: CodexHistoryImageLoader = { imageBlockFromLocalPath: () => null };
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, any>;
    const type = typeof candidate.type === 'string' ? candidate.type : '';
    if (type !== 'input_text' && type !== 'text') continue;
    textBlocks.push(...parseCodexTextAndImages(String(candidate.text || ''), nullImageLoader));
  }
  return extractTextFromBlocks(textBlocks).trim();
}

function contentBlockKey(block: Record<string, unknown>): string | null {
  if (block.type !== 'image') return null;
  const source = block.source && typeof block.source === 'object'
    ? block.source as Record<string, unknown>
    : undefined;
  if (typeof source?.data === 'string' && source.data) {
    return `image:data:${source.media_type || ''}:${source.data}`;
  }
  if (typeof block.src === 'string' && block.src) {
    return `image:src:${block.src}`;
  }
  if (typeof block.path === 'string' && block.path) {
    return `image:path:${block.path}`;
  }
  return null;
}

function dedupeContentBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = contentBlockKey(block);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function convertCodexEventUserMessage(
  payload: CodexPayload,
  imageLoader: CodexHistoryImageLoader,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
  for (const filePath of localImages) {
    if (typeof filePath !== 'string') continue;
    const imageBlock = imageLoader.imageBlockFromLocalPath(filePath);
    if (imageBlock) blocks.push(imageBlock);
  }

  const inlineImages = Array.isArray(payload.images) ? payload.images : [];
  for (const image of inlineImages) {
    const imageBlock = imageBlockFromDataUrl(image);
    if (imageBlock) blocks.push(imageBlock);
  }

  const text = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (text) {
    blocks.push(...parseCodexTextAndImages(text, imageLoader));
  }

  return coalesceAdjacentTextBlocks(blocks);
}

function convertCodexReasoningPayload(payload: CodexPayload): Array<Record<string, unknown>> {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  const text = summary
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      if (typeof entry.text === 'string') return entry.text.trim();
      if (typeof entry.summary === 'string') return entry.summary.trim();
      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  if (!text) return [];
  return [{ type: 'thinking', thinking: text, text }];
}

function convertCodexFunctionCallPayload(payload: CodexPayload): Record<string, unknown> | null {
  const toolName = typeof payload.name === 'string' ? payload.name : '';
  if (!toolName) return null;

  const parsedArguments = parseToolArguments(payload.arguments);
  const normalized = normalizeFunctionCallTool(toolName, parsedArguments);
  return {
    type: 'tool_use',
    id: typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : payload.id,
    name: normalized.name,
    input: normalized.input,
  };
}

function convertCodexFunctionCallOutputPayload(payload: CodexPayload): Record<string, unknown> | null {
  const toolUseId = typeof payload.call_id === 'string' ? payload.call_id : '';
  if (!toolUseId) return null;

  const content = stringifyToolOutput(payload.output);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: payload.status === 'error',
    content: content || '(no output)',
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function normalizeFunctionCallTool(
  toolName: string,
  parsedArguments: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpMatch) {
    const [, server, tool] = mcpMatch;
    return {
      name: normalizeMcpToolName(server, tool),
      input: normalizeMcpToolInput(server, tool, parsedArguments),
    };
  }

  if (toolName === 'update_plan') {
    return {
      name: toolName,
      input: normalizeUpdatePlanInput(parsedArguments),
    };
  }

  return { name: toolName, input: parsedArguments };
}

function normalizeMcpToolName(server: string, tool: string): string {
  const serverName = String(server || '').toLowerCase();
  const toolName = String(tool || '').toLowerCase();

  if (serverName === 'filesystem') {
    if (toolName === 'edit_file') return 'edit_file';
    if (toolName === 'write_file') return 'write_to_file';
    if (toolName === 'read_text_file' || toolName === 'read_multiple_files') return 'read_file';
    if (toolName === 'search_files') return 'search';
  }

  return `mcp__${server}__${tool}`;
}

function normalizeMcpToolInput(server: string, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const serverName = String(server || '').toLowerCase();
  const toolName = String(tool || '').toLowerCase();
  const input = { ...args };

  if (serverName !== 'filesystem') {
    return input;
  }

  if (typeof input.path === 'string') {
    input.file_path = input.path;
  }

  if (toolName === 'edit_file') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const firstEdit = edits[0] && typeof edits[0] === 'object' ? edits[0] as Record<string, unknown> : null;
    if (firstEdit) {
      if (typeof firstEdit.oldText === 'string') input.old_string = firstEdit.oldText;
      if (typeof firstEdit.newText === 'string') input.new_string = firstEdit.newText;
      if (typeof firstEdit.oldText === 'string') input.oldString = firstEdit.oldText;
      if (typeof firstEdit.newText === 'string') input.newString = firstEdit.newText;
    }
  } else if (toolName === 'write_file' && typeof input.content === 'string') {
    input.old_string = '';
    input.new_string = input.content;
    input.oldString = '';
    input.newString = input.content;
  }

  return input;
}

function normalizeUpdatePlanInput(input: Record<string, unknown>): Record<string, unknown> {
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

function normalizePlanStatus(status: unknown): string {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function replaceTextBlocks(
  blocks: Array<Record<string, unknown>>,
  replacementText: string,
): Array<Record<string, unknown>> {
  const trimmed = replacementText.trim();
  let textInserted = false;
  const result: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    if (block.type !== 'text') {
      result.push(block);
      continue;
    }
    if (!trimmed || textInserted) continue;
    result.push({ type: 'text', text: trimmed });
    textInserted = true;
  }

  if (trimmed && !textInserted) {
    result.push({ type: 'text', text: trimmed });
  }
  return result;
}

function extractTextFromBlocks(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return String(block.text).trim();
      }
      if (block.type === 'thinking') {
        const thinking = typeof block.thinking === 'string' ? block.thinking : block.text;
        return typeof thinking === 'string' ? thinking.trim() : '';
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        return block.content.trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function coalesceAdjacentTextBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type !== 'text') {
      result.push(block);
      continue;
    }
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    if (!text) continue;
    const prev = result[result.length - 1];
    if (prev?.type === 'text' && typeof prev.text === 'string') {
      prev.text = `${String(prev.text).trim()}\n${text}`;
      continue;
    }
    result.push({ type: 'text', text });
  }
  return result;
}

export function loadCodexHistoryRowsFromFile(filePath: string): CodexJsonlRow[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row): row is CodexJsonlRow => Boolean(row));
}
