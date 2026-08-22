import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { getCustomModelPricing } from './customPricingStore';

const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4':        { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4':      { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4':       { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-opus-4-5':      { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-5':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4-5':     { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-3-7-sonnet':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-3-5-sonnet':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-3-5-haiku':     { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-3-opus':        { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-3-haiku':       { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3   },
};

export interface UsageRecordInput {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp?: number;
  costOverride?: number;
  summary?: string;
}

export class UsageStatisticsService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getWorkspacePath: () => string,
  ) {}

  estimateCost(model: string, inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number): number {
    const defaults = Object.entries(MODEL_PRICING).find(([key]) => model.toLowerCase().startsWith(key))?.[1]
      ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    // User-configured pricing overrides defaults per field; unset fields fall back to the default rate.
    const custom = getCustomModelPricing(model);
    const pricing = {
      input:      custom?.inputCostPer1M      ?? defaults.input,
      output:     custom?.outputCostPer1M     ?? defaults.output,
      cacheRead:  custom?.cacheReadCostPer1M  ?? defaults.cacheRead,
      cacheWrite: custom?.cacheWriteCostPer1M ?? defaults.cacheWrite,
    };
    return (
      (inputTokens  * pricing.input      / 1_000_000) +
      (outputTokens * pricing.output     / 1_000_000) +
      (cacheRead    * pricing.cacheRead  / 1_000_000) +
      (cacheWrite   * pricing.cacheWrite / 1_000_000)
    );
  }

  recordUsage(input: UsageRecordInput, options: { avoidDailyDoubleCount: boolean }): { cost: number } {
    const cost = input.costOverride ?? this.estimateCost(input.model, input.inputTokens, input.outputTokens, input.cacheRead, input.cacheWrite);
    const now = input.timestamp ?? Date.now();
    const dateKey = new Date(now).toISOString().slice(0, 10);
    const stats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };
    stats.sessions = Array.isArray(stats.sessions) ? stats.sessions : [];
    stats.dailyMap = stats.dailyMap && typeof stats.dailyMap === 'object' ? stats.dailyMap : {};

    if (input.sessionId) {
      const existing = stats.sessions.findIndex((s: any) => s.sessionId === input.sessionId);
      const entry: any = {
        sessionId: input.sessionId,
        timestamp: now,
        model: input.model,
        usage: {
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheWriteTokens: input.cacheWrite,
          cacheReadTokens: input.cacheRead,
          totalTokens: input.inputTokens + input.outputTokens,
        },
        cost,
      };
      if (input.summary) {
        entry.summary = input.summary;
      }
      if (existing >= 0) stats.sessions[existing] = entry; else stats.sessions.push(entry);
    }

    const day = stats.dailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
    const alreadyToday = input.sessionId && stats.sessions.some((s: any) =>
      s.sessionId === input.sessionId && new Date(s.timestamp).toISOString().slice(0, 10) === dateKey
    );

    if (!options.avoidDailyDoubleCount || !alreadyToday || !input.sessionId) {
      day.cost += cost;
      day.inputTokens += input.inputTokens;
      day.outputTokens += input.outputTokens;
      day.sessions++;
    } else {
      day.cost = (day.cost - (stats.sessions.find((s: any) => s.sessionId === input.sessionId)?.cost ?? 0)) + cost;
    }

    if (!Array.isArray(day.modelsUsed)) {
      day.modelsUsed = [];
    }
    if (!day.modelsUsed.includes(input.model)) day.modelsUsed.push(input.model);
    stats.dailyMap[dateKey] = day;
    void this.context.globalState.update('ccg.usageStats', stats);
    return { cost };
  }

  postUsageUpdate(
    webview: vscode.Webview,
    inputTokens: number,
    options?: { maxTokens?: number; model?: string; provider?: string },
  ): void {
    const maxTokens = this.resolveMaxTokens(options);
    webview.postMessage({ type: 'usage_update', content: JSON.stringify({
      percentage: Math.min(100, maxTokens > 0 ? (inputTokens / maxTokens) * 100 : 0),
      usedTokens: inputTokens,
      maxTokens,
    })});
  }

  private resolveMaxTokens(options?: { maxTokens?: number; model?: string; provider?: string }): number {
    if (typeof options?.maxTokens === 'number' && options.maxTokens > 0) {
      return options.maxTokens;
    }
    try {
      // Lazy require to avoid circular imports at module load time.
      const { getCustomContextWindow } = require('./customContextWindowStore') as typeof import('./customContextWindowStore');
      const provider = options?.provider || 'codex';
      const model = options?.model || '';
      const custom = model ? getCustomContextWindow(provider, model) : undefined;
      if (typeof custom === 'number' && custom > 0) return custom;
    } catch { /* ignore */ }
    return 200000;
  }

  postStatistics(webview: vscode.Webview): void {
    const stats = this.buildStatistics();
    webview.postMessage({ type: 'update_usage_statistics', content: JSON.stringify(stats) });
  }

  private buildStatistics(): any {
    const stored = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };
    const sessions: any[] = stored.sessions ?? [];
    const dailyMap: Record<string, any> = stored.dailyMap ?? {};

    let needsSave = false;
    for (const s of sessions) {
      if ((s.cost === 0 || s.cost == null) && s.usage && (s.usage.inputTokens > 0 || s.usage.outputTokens > 0)) {
        s.cost = this.estimateCost(
          s.model ?? 'unknown',
          s.usage.inputTokens ?? 0,
          s.usage.outputTokens ?? 0,
          s.usage.cacheReadTokens ?? 0,
          s.usage.cacheWriteTokens ?? 0,
        );
        needsSave = true;
      }
    }

    if (needsSave) {
      const rebuiltDailyMap: Record<string, any> = {};
      for (const s of sessions) {
        const dateKey = new Date(s.timestamp).toISOString().slice(0, 10);
        const day = rebuiltDailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
        day.cost += s.cost ?? 0;
        day.inputTokens += s.usage?.inputTokens ?? 0;
        day.outputTokens += s.usage?.outputTokens ?? 0;
        day.sessions++;
        if (s.model && !day.modelsUsed.includes(s.model)) day.modelsUsed.push(s.model);
        rebuiltDailyMap[dateKey] = day;
      }
      for (const [date, day] of Object.entries(rebuiltDailyMap)) {
        dailyMap[date] = day;
      }
      void this.context.globalState.update('ccg.usageStats', { sessions, dailyMap });
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    const dailyUsage = Object.entries(dailyMap).map(([date, d]: [string, any]) => {
      totalInputTokens += d.inputTokens ?? 0;
      totalOutputTokens += d.outputTokens ?? 0;
      totalCost += d.cost ?? 0;
      return {
        date,
        sessions: d.sessions ?? 0,
        cost: d.cost ?? 0,
        usage: {
          inputTokens: d.inputTokens ?? 0,
          outputTokens: d.outputTokens ?? 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: (d.inputTokens ?? 0) + (d.outputTokens ?? 0),
        },
        modelsUsed: d.modelsUsed ?? [],
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    const modelMap = new Map<string, any>();
    for (const s of sessions) {
      const model = s.model ?? 'unknown';
      const entry = modelMap.get(model) ?? { model, totalCost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, sessionCount: 0 };
      entry.totalCost += s.cost ?? 0;
      entry.inputTokens += s.usage?.inputTokens ?? 0;
      entry.outputTokens += s.usage?.outputTokens ?? 0;
      entry.totalTokens += s.usage?.totalTokens ?? 0;
      entry.sessionCount++;
      modelMap.set(model, entry);
    }

    const workspacePath = this.getWorkspacePath() || os.homedir();
    return {
      projectPath: workspacePath,
      projectName: path.basename(workspacePath),
      totalSessions: sessions.length,
      totalUsage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
      estimatedCost: totalCost,
      sessions: sessions.slice(-100).reverse(),
      dailyUsage,
      weeklyComparison: {
        currentWeek: { sessions: 0, cost: 0, tokens: 0 },
        lastWeek: { sessions: 0, cost: 0, tokens: 0 },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      byModel: Array.from(modelMap.values()),
      lastUpdated: Date.now(),
    };
  }
}
