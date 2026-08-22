import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GrokHistoryReader } from '../bridge/services/GrokHistoryReader.ts';

let tmpRoot: string;
let sessionsRoot: string;
const projectPath = '/Users/test/project';

function sessionDir(sessionId: string, cwd: string = projectPath): string {
  const encoded = encodeURIComponent(cwd.replace(/\\/g, '/').replace(/\/+$/, ''));
  const dir = path.join(sessionsRoot, encoded, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeChat(sessionId: string, lines: object[], cwd: string = projectPath): void {
  const dir = sessionDir(sessionId, cwd);
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify({
      generated_title: 'Test Session',
      num_chat_messages: lines.length,
      created_at: '2026-08-10T00:00:00.000Z',
      updated_at: '2026-08-10T01:00:00.000Z',
    }),
    'utf8',
  );
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-history-reader-'));
  sessionsRoot = path.join(tmpRoot, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
});

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  if (fs.existsSync(sessionsRoot)) {
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionsRoot, { recursive: true });
});

describe('GrokHistoryReader', () => {
  it('lists sessions for a project cwd (including trailing-slash variants)', () => {
    writeChat('sess-1', [
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    const reader = new GrokHistoryReader(sessionsRoot);
    const withSlash = reader.getSessionsForProject(projectPath + '/');
    assert.equal(withSlash.success, true);
    assert.equal(withSlash.sessions.length, 1);
    assert.equal(withSlash.sessions[0].sessionId, 'sess-1');
    assert.equal(withSlash.sessions[0].provider, 'grok');
  });

  it('uses the user-typed first prompt as title, not AI generated_title', () => {
    const dir = sessionDir('sess-title');
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }] }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\n1+2\n</user_query>' }] }),
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '**3**' }] }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        generated_title: 'Simple Arithmetic Calculation 1 Plus 2',
        session_summary: 'Simple Arithmetic Calculation 1 Plus 2',
        num_chat_messages: 3,
        created_at: '2026-08-10T00:00:00.000Z',
        updated_at: '2026-08-10T01:00:00.000Z',
      }),
      'utf8',
    );

    const reader = new GrokHistoryReader(sessionsRoot);
    const result = reader.getSessionsForProject(projectPath);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].title, '1+2');
  });

  it('uses Chinese user_query as title even when the turn starts with <image_files>', () => {
    const dir = sessionDir('sess-image-title');
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }] }),
        JSON.stringify({
          type: 'user',
          content: [
            {
              type: 'text',
              text:
                '<image_files>\n' +
                'The following images were provided by the user and saved to the workspace for future use:\n' +
                '1. /tmp/assets/image-abc.png\n' +
                '\n' +
                'These images can be copied for use in other locations.\n' +
                '</image_files>\n' +
                '\n' +
                '<user_query>\n' +
                '图片上是啥?\n' +
                '</user_query>',
            },
            {
              type: 'image',
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            },
          ],
        }),
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'a logo' }] }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        generated_title: 'What Is On The Image Query',
        session_summary: 'What Is On The Image Query',
        num_chat_messages: 3,
        created_at: '2026-08-10T00:00:00.000Z',
        updated_at: '2026-08-10T01:00:00.000Z',
      }),
      'utf8',
    );

    const reader = new GrokHistoryReader(sessionsRoot);
    const result = reader.getSessionsForProject(projectPath);
    const session = result.sessions.find((s) => s.sessionId === 'sess-image-title');
    assert.ok(session, 'session listed');
    assert.equal(session!.title, '图片上是啥?');
    assert.notEqual(session!.title, 'What Is On The Image Query');
  });

  it('returns GUI-shaped messages so the webview can render history', () => {
    writeChat('sess-2', [
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }] },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\n1+2\n</user_query>' }], synthetic_reason: 'ignored' },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\n1+2\n</user_query>' }] },
      { type: 'assistant', content: [{ type: 'text', text: '**3**' }] },
      {
        type: 'assistant',
        content: [],
        tool_calls: [{ id: 'call-1', function: { name: 'run_terminal_command', arguments: '{"command":"ls"}' } }],
      },
      { type: 'tool_result', tool_call_id: 'call-1', content: 'ok' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking…' }] },
    ]);

    const reader = new GrokHistoryReader(sessionsRoot);
    const messages = reader.getSessionMessages('sess-2', projectPath);

    // user_info + synthetic user are filtered out
    const users = messages.filter((m) => m.type === 'user' && typeof m.content === 'string' && m.content === '1+2');
    assert.equal(users.length, 1);

    const assistant = messages.find((m) => m.type === 'assistant' && m.content === '**3**');
    assert.ok(assistant, 'assistant text message present');

    // Shape must match Claude history rows used by the webview
    for (const msg of messages) {
      assert.equal(typeof msg.type, 'string');
      assert.ok('content' in msg, 'message must expose content');
      assert.ok(msg.raw && typeof msg.raw === 'object', 'message must expose raw');
      const raw = msg.raw as { uuid?: string; message?: { role?: string; content?: unknown } };
      assert.ok(raw.message && typeof raw.message === 'object', 'raw.message required');
      assert.ok(Array.isArray(raw.message.content), 'raw.message.content must be blocks');
      assert.ok(typeof raw.uuid === 'string' && raw.uuid.length > 0, 'raw.uuid required');
      // Must NOT use the CLI jsonl top-level `message` field as the only payload
      assert.equal((msg as { message?: unknown }).message, undefined);
    }

    const toolUse = messages.find((m) => {
      const blocks = (m.raw as any)?.message?.content;
      return Array.isArray(blocks) && blocks.some((b: any) => b?.type === 'tool_use');
    });
    assert.ok(toolUse, 'tool_use row present');

    const toolResult = messages.find((m) => {
      const blocks = (m.raw as any)?.message?.content;
      return Array.isArray(blocks) && blocks.some((b: any) => b?.type === 'tool_result');
    });
    assert.ok(toolResult, 'tool_result row present');
  });

  it('restores inline image blocks (data URL) when reloading Grok history', () => {
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    writeChat('sess-image-url', [
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              '<image_files>\n' +
              'The following images were provided by the user and saved to the workspace for future use:\n' +
              '1. /tmp/fake-session/assets/image-abc.png\n' +
              '\n' +
              'These images can be copied for use in other locations.\n' +
              '</image_files>\n' +
              '\n' +
              '<user_query>\n' +
              '图片里面有啥\n' +
              '</user_query>',
          },
          {
            type: 'image',
            url: `data:image/png;base64,${tinyPngBase64}`,
          },
        ],
      },
      { type: 'assistant', content: [{ type: 'text', text: 'a red pixel' }] },
    ]);

    const reader = new GrokHistoryReader(sessionsRoot);
    const messages = reader.getSessionMessages('sess-image-url', projectPath);
    const user = messages.find((m) => m.type === 'user');
    assert.ok(user, 'user message present');
    assert.equal(user!.content, '图片里面有啥');

    const blocks = (user!.raw as any)?.message?.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(blocks), 'content blocks required');
    const image = blocks.find((b) => b?.type === 'image') as any;
    assert.ok(image, 'image block must be restored from history');
    assert.equal(image.source?.type, 'base64');
    assert.equal(image.source?.media_type, 'image/png');
    assert.equal(image.source?.data, tinyPngBase64);

    const text = blocks.find((b) => b?.type === 'text') as any;
    assert.equal(text?.text, '图片里面有啥');
    // Must not leak Grok's <image_files> bookkeeping into the chat bubble
    assert.ok(!String(user!.content).includes('<image_files>'));
    assert.ok(!String(text?.text || '').includes('<image_files>'));
  });

  it('restores images from <image_files> asset paths when base64 block is absent', () => {
    const dir = sessionDir('sess-image-path');
    const assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const imagePath = path.join(assetsDir, 'image-from-disk.png');
    // Minimal valid 1x1 PNG
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );

    writeChat('sess-image-path', [
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              `<image_files>\n1. ${imagePath}\n</image_files>\n\n` +
              '<user_query>\nlook at this\n</user_query>',
          },
        ],
      },
    ]);

    const reader = new GrokHistoryReader(sessionsRoot);
    const messages = reader.getSessionMessages('sess-image-path', projectPath);
    const user = messages.find((m) => m.type === 'user');
    assert.ok(user);
    assert.equal(user!.content, 'look at this');
    const blocks = (user!.raw as any)?.message?.content as Array<Record<string, unknown>>;
    const image = blocks.find((b) => b?.type === 'image') as any;
    assert.ok(image, 'image must be loaded from assets path');
    assert.equal(image.source?.type, 'base64');
    assert.equal(image.source?.media_type, 'image/png');
    assert.ok(typeof image.source?.data === 'string' && image.source.data.length > 0);
  });

  it('keeps image-only user turns (no typed text) instead of dropping them', () => {
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    writeChat('sess-image-only', [
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              '<image_files>\n1. /tmp/x.png\n</image_files>\n',
          },
          { type: 'image', url: `data:image/png;base64,${tinyPngBase64}` },
        ],
      },
    ]);

    const reader = new GrokHistoryReader(sessionsRoot);
    const messages = reader.getSessionMessages('sess-image-only', projectPath);
    assert.equal(messages.length, 1);
    const blocks = (messages[0].raw as any)?.message?.content as Array<Record<string, unknown>>;
    assert.ok(blocks.some((b) => b?.type === 'image'));
  });
});
