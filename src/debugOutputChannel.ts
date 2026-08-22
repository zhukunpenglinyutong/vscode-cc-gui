import type * as vscode from 'vscode';

/**
 * Gate debug writes without monkey-patching OutputChannel methods.
 *
 * Older builds replaced `channel.appendLine` / `append` with no-ops on the
 * reused named channel. We never mutate those methods: a flag-gated facade
 * decides whether to call the real writers, which are bound once at create time.
 */
export interface DebugGatedOutput {
  /** Raw VS Code channel (show / dispose / force writes). */
  raw: vscode.OutputChannel;
  /** Facade: append/appendLine respect `isEnabled()`; show/clear always work. */
  log: vscode.OutputChannel;
  forceAppendLine: (value: string) => void;
  forceAppend: (value: string) => void;
}

export type CreateOutputChannel = (name: string) => vscode.OutputChannel;

/**
 * Bind append* once. Never delete channel methods — on VS Code they are often
 * own properties; deleting them makes appendLine undefined and crashes activate
 * with: Cannot read properties of undefined (reading 'bind').
 */
export function captureAppendWriters(channel: vscode.OutputChannel): {
  forceAppendLine: (value: string) => void;
  forceAppend: (value: string) => void;
} {
  const appendLine =
    typeof channel.appendLine === 'function'
      ? channel.appendLine.bind(channel)
      : (_value: string) => {};
  const append =
    typeof channel.append === 'function'
      ? channel.append.bind(channel)
      : (_value: string) => {};
  return { forceAppendLine: appendLine, forceAppend: append };
}

/**
 * Create a fresh named channel and a flag-gated facade for append*.
 * Disposes any prior same-name channel so a previously monkey-patched instance
 * is not reused (safe heal without deleting methods on a live channel).
 */
export function createDebugGatedOutputChannel(
  name: string,
  isEnabled: () => boolean,
  createOutputChannel: CreateOutputChannel,
): DebugGatedOutput {
  try {
    createOutputChannel(name).dispose();
  } catch {
    // ignore dispose races
  }

  const raw = createOutputChannel(name);
  const { forceAppendLine, forceAppend } = captureAppendWriters(raw);

  const log: vscode.OutputChannel = {
    get name() {
      return raw.name;
    },
    append(value: string) {
      if (isEnabled()) forceAppend(value);
    },
    appendLine(value: string) {
      if (isEnabled()) forceAppendLine(value);
    },
    replace(value: string) {
      if (isEnabled() && typeof raw.replace === 'function') {
        raw.replace(value);
      }
    },
    clear() {
      raw.clear();
    },
    show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean) {
      if (typeof columnOrPreserveFocus === 'boolean' || columnOrPreserveFocus === undefined) {
        raw.show(columnOrPreserveFocus);
      } else {
        raw.show(columnOrPreserveFocus, preserveFocus);
      }
    },
    hide() {
      raw.hide();
    },
    dispose() {
      raw.dispose();
    },
  };

  return { raw, log, forceAppendLine, forceAppend };
}
