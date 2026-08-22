/**
 * Direct Codex CLI JSONL runner.
 *
 * The TypeScript SDK is a thin wrapper around `codex exec --experimental-json`.
 * Running the installed CLI wrapper directly keeps the bridge behavior aligned
 * with a user's working terminal `codex` command.
 */

import { spawn } from 'child_process';
import readline from 'readline';
import { getCodexCliEntrypoint } from '../../utils/sdk-loader.js';

function normalizeInput(input) {
  if (typeof input === 'string') {
    return { prompt: input, images: [] };
  }

  const promptParts = [];
  const images = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        promptParts.push(item.text);
      } else if (item.type === 'local_image' && typeof item.path === 'string' && item.path) {
        images.push(item.path);
      }
    }
  }

  return { prompt: promptParts.join('\n\n'), images };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key) {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function toTomlValue(value, path) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${path} must be a finite number`);
    }
    return `${value}`;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${path}[${index}]`)).join(', ')}]`;
  }
  if (isPlainObject(value)) {
    const parts = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) {
        throw new Error('Codex config override keys must be non-empty strings');
      }
      if (child === undefined) {
        continue;
      }
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child, `${path}.${key}`)}`);
    }
    return `{${parts.join(', ')}}`;
  }
  if (value === null) {
    throw new Error(`Codex config override at ${path} cannot be null`);
  }
  throw new Error(`Unsupported Codex config override value at ${path}: ${typeof value}`);
}

function flattenConfigOverrides(value, prefix, overrides) {
  if (!isPlainObject(value)) {
    if (!prefix) {
      throw new Error('Codex config overrides must be a plain object');
    }
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }

  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) {
    return;
  }
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    if (!key) {
      throw new Error('Codex config override keys must be non-empty strings');
    }
    if (child === undefined) {
      continue;
    }
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, childPath, overrides);
    } else {
      overrides.push(`${childPath}=${toTomlValue(child, childPath)}`);
    }
  }
}

function serializeConfigOverrides(configOverrides) {
  const overrides = [];
  if (configOverrides) {
    flattenConfigOverrides(configOverrides, '', overrides);
  }
  return overrides;
}

function appendThreadArgs(args, options) {
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode);
  }
  if (options.workingDirectory) {
    args.push('--cd', options.workingDirectory);
  }
  if (Array.isArray(options.additionalDirectories)) {
    for (const dir of options.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }
  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (options.outputSchemaFile) {
    args.push('--output-schema', options.outputSchemaFile);
  }
  if (options.modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort=${toTomlValue(options.modelReasoningEffort, 'model_reasoning_effort')}`);
  }
  if (options.networkAccessEnabled !== undefined) {
    args.push('--config', `sandbox_workspace_write.network_access=${options.networkAccessEnabled ? 'true' : 'false'}`);
  }
  if (options.webSearchMode) {
    args.push('--config', `web_search=${toTomlValue(options.webSearchMode, 'web_search')}`);
  } else if (options.webSearchEnabled === true) {
    args.push('--config', 'web_search="live"');
  } else if (options.webSearchEnabled === false) {
    args.push('--config', 'web_search="disabled"');
  }
  if (options.approvalPolicy) {
    args.push('--config', `approval_policy=${toTomlValue(options.approvalPolicy, 'approval_policy')}`);
  }
}

function buildCliArgs(cliOptions, threadOptions, runOptions, images) {
  const args = ['exec', '--experimental-json'];

  for (const override of serializeConfigOverrides(cliOptions.config)) {
    args.push('--config', override);
  }
  if (cliOptions.baseUrl) {
    args.push('--config', `openai_base_url=${toTomlValue(cliOptions.baseUrl, 'openai_base_url')}`);
  }

  appendThreadArgs(args, threadOptions);

  if (runOptions.threadId) {
    args.push('resume', runOptions.threadId);
  }
  for (const image of images) {
    args.push('--image', image);
  }

  return args;
}

/**
 * Run Codex CLI and yield parsed JSON events.
 *
 * @param {string|Array} input
 * @param {object} cliOptions - { baseUrl, apiKey, config, env }
 * @param {object} threadOptions
 * @param {object} runOptions - { threadId, signal }
 */
export async function* runCodexCliStream(input, cliOptions = {}, threadOptions = {}, runOptions = {}) {
  const { prompt, images } = normalizeInput(input);
  const { wrapperPath } = getCodexCliEntrypoint();
  const cliArgs = buildCliArgs(cliOptions, threadOptions, runOptions, images);
  const nodeArgs = [wrapperPath, ...cliArgs];
  const env = { ...(cliOptions.env || process.env) };
  const childWorkingDirectory =
    typeof runOptions.cwd === 'string' && runOptions.cwd.trim() !== ''
      ? runOptions.cwd
      : typeof threadOptions.workingDirectory === 'string' && threadOptions.workingDirectory.trim() !== ''
        ? threadOptions.workingDirectory
        : undefined;

  if (cliOptions.apiKey) {
    env.CODEX_API_KEY = cliOptions.apiKey;
  }

  const child = spawn(process.execPath, nodeArgs, {
    env,
    cwd: childWorkingDirectory,
    signal: runOptions.signal
  });

  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  if (!child.stdin) {
    child.kill();
    throw new Error('Codex CLI child process has no stdin');
  }
  child.stdin.write(prompt);
  child.stdin.end();

  if (!child.stdout) {
    child.kill();
    throw new Error('Codex CLI child process has no stdout');
  }

  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      stderrChunks.push(Buffer.from(data));
    });
  }

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      if (!line || !line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse item: ${line}`, { cause: error });
      }
    }

    if (spawnError) {
      throw spawnError;
    }

    const { code, signal } = await exitPromise;
    if (code !== 0 || signal) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      throw new Error(`Codex CLI exited with ${detail}${stderr ? `: ${stderr}` : ''}`);
    }
  } finally {
    rl.close();
    child.removeAllListeners();
    try {
      if (!child.killed) {
        child.kill();
      }
    } catch {
      // ignore cleanup failure
    }
  }
}
