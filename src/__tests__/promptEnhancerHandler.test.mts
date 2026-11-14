import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { resolvePromptEnhancerRuntimeConfig } from '../../ai-bridge/services/prompt-enhancer.js';

// Exercise the actual handler with VS Code and the SDK subprocess stubbed out.
// The project's TypeScript compiler handles constructor parameter properties without
// requiring an extension host, installed AI SDKs, credentials, or network access.
const source = readFileSync(
  new URL('../bridge/handlers/PromptEnhancerHandler.ts', import.meta.url),
  'utf8',
).replace(/^import\b[\s\S]*?;\r?\n/gm, '')
  .replace('export class PromptEnhancerHandler', 'class PromptEnhancerHandler');
const handlerScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText
  + '\nPromptEnhancerHandler;';

function configFor(provider: 'claude' | 'codex', model: string) {
  return {
    provider,
    effectiveProvider: provider,
    resolutionSource: 'manual',
    models: { claude: 'test-claude-model', codex: 'test-codex-model', [provider]: model },
    availability: { claude: provider === 'claude', codex: provider === 'codex' },
  };
}

type EnhancerConfig = Omit<ReturnType<typeof configFor>, 'provider'> & {
  provider: 'claude' | 'codex' | null;
};

function createHarness(config: EnhancerConfig) {
  const requests: any[] = [];
  const responses: any[] = [];
  const store = { getPromptEnhancerConfig: () => config };
  const context = {
    extensionContext: { extensionPath: '/test-extension' },
    getWorkspacePath: () => '/test-workspace',
    log: { appendLine() {} },
  };
  const Handler = runInNewContext(handlerScript, {
    vscode: { window: { activeTextEditor: undefined } },
    path,
    fs: { existsSync: () => true },
    cp: {
      spawn() {
        const proc = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          stdin: {
            end(input: string) {
              requests.push(JSON.parse(input));
              queueMicrotask(() => {
                proc.stdout.emit('data', Buffer.from('[ENHANCED]Optimized prompt\n'));
                proc.emit('close', 0);
              });
            },
          },
          kill() {},
        });
        return proc;
      },
    },
    NodeDetector: { find: () => process.execPath },
    parseJson: (content: string, fallback: unknown) => {
      try { return JSON.parse(content); } catch { return fallback; }
    },
    callWindowFunction: (_webview: unknown, name: string, result: unknown) => {
      responses.push({ name, result: JSON.parse(JSON.stringify(result)) });
    },
    process,
    setTimeout,
    clearTimeout,
  });
  const handler = new Handler(context, store);
  return {
    requests,
    responses,
    setConfig(next: EnhancerConfig) { config = next; },
    enhance: (payload: Record<string, unknown>) => handler.handle({
      event: 'enhance_prompt', content: JSON.stringify(payload), webview: {},
    }),
  };
}

describe('PromptEnhancerHandler saved provider and model', () => {
  it('forwards Codex settings when the webview sends only a prompt', async () => {
    const config = configFor('codex', 'selected-codex-model');
    const harness = createHarness(config);

    assert.equal(await harness.enhance({ prompt: '  Improve this  ' }), true);

    assert.equal(harness.requests[0].prompt, 'Improve this');
    assert.deepEqual(harness.requests[0].promptEnhancerConfig, config);
    assert.deepEqual(resolvePromptEnhancerRuntimeConfig(harness.requests[0]), {
      provider: 'codex', model: 'selected-codex-model', resolutionSource: 'manual',
    });
    assert.deepEqual(harness.responses, [{
      name: 'updateEnhancedPrompt',
      result: { success: true, enhancedPrompt: 'Optimized prompt' },
    }]);
  });

  it('forwards the selected Claude model instead of a chat model override', async () => {
    const config = configFor('claude', 'selected-claude-model');
    const harness = createHarness(config);

    await harness.enhance({ prompt: 'Improve this', model: 'unrelated-chat-model' });

    assert.deepEqual(harness.requests[0].promptEnhancerConfig, config);
    assert.equal(harness.requests[0].model, undefined);
    assert.deepEqual(resolvePromptEnhancerRuntimeConfig(harness.requests[0]), {
      provider: 'claude', model: 'selected-claude-model', resolutionSource: 'manual',
    });
  });

  it('reads updated provider and model settings for each request', async () => {
    const harness = createHarness(configFor('codex', 'first-model'));
    await harness.enhance({ prompt: 'First request' });

    const next = configFor('claude', 'second-model');
    harness.setConfig(next);
    await harness.enhance({ prompt: 'Second request' });

    assert.equal(harness.requests[0].promptEnhancerConfig.models.codex, 'first-model');
    assert.deepEqual(harness.requests[1].promptEnhancerConfig, next);
    assert.deepEqual(resolvePromptEnhancerRuntimeConfig(harness.requests[1]), {
      provider: 'claude', model: 'second-model', resolutionSource: 'manual',
    });
  });

  it('preserves the resolved provider in automatic mode', async () => {
    const config = { ...configFor('codex', 'auto-model'), provider: null, resolutionSource: 'auto' };
    const harness = createHarness(config);

    await harness.enhance({ prompt: 'Improve this' });

    assert.deepEqual(harness.requests[0].promptEnhancerConfig, config);
  });
});
