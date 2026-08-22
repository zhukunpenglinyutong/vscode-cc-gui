import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { ModelPricing, setCustomModelPricing } from '../services/customPricingStore';
import { setCustomContextWindows } from '../services/customContextWindowStore';

const SET_EVENT = 'set_custom_model_pricing';
const PRICE_FIELDS: (keyof ModelPricing)[] = [
  'inputCostPer1M',
  'outputCostPer1M',
  'cacheWriteCostPer1M',
  'cacheReadCostPer1M',
];

function readPrice(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parsePricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const pricing = PRICE_FIELDS.reduce<ModelPricing>((acc, field) => {
    const value = readPrice(obj[field]);
    return value === undefined ? acc : { ...acc, [field]: value };
  }, {});
  return PRICE_FIELDS.some((field) => pricing[field] !== undefined) ? pricing : undefined;
}

/**
 * Persists user-configured model pricing sent by the webview.
 *
 * The frontend emits `set_custom_model_pricing` whenever plugin-level custom models or
 * pricing-only Claude configured models change. Payload shape:
 * `{ "provider": "claude"|"codex", "models": [ { "id": "...", "pricing": { ... }, "contextWindowTokens"?: number } ] }`.
 * Models without a valid `pricing` field are omitted so cost calculation falls back to defaults.
 * Codex models may also carry `contextWindowTokens` (multiples of 1000).
 */
export class CustomModelPricingHandler implements BridgeHandler {
  readonly supportedEvents = [SET_EVENT] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content }: BridgeMessage): boolean {
    if (event !== SET_EVENT) return false;
    try {
      const payload = JSON.parse(content) as { provider?: unknown; models?: unknown };
      const provider = payload.provider;
      if (provider !== 'claude' && provider !== 'codex') {
        this.context.log.appendLine(`[CustomModelPricingHandler] Rejected unknown provider: ${String(provider)}`);
        return true;
      }

      const models = Array.isArray(payload.models) ? payload.models : [];
      const pricingMap = models.reduce<Record<string, ModelPricing>>((acc, entry) => {
        if (!entry || typeof entry !== 'object') return acc;
        const id = typeof (entry as any).id === 'string' ? (entry as any).id.trim() : '';
        if (!id) return acc;
        const pricing = parsePricing((entry as any).pricing);
        return pricing ? { ...acc, [id]: pricing } : acc;
      }, {});

      setCustomModelPricing(provider, pricingMap);

      if (provider === 'codex') {
        const windows = models.reduce<Record<string, number>>((acc, entry) => {
          if (!entry || typeof entry !== 'object') return acc;
          const id = typeof (entry as any).id === 'string' ? (entry as any).id.trim() : '';
          if (!id) return acc;
          const tokens = (entry as any).contextWindowTokens;
          if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 1000 && tokens % 1000 === 0) {
            return { ...acc, [id]: tokens };
          }
          return acc;
        }, {});
        setCustomContextWindows('codex', windows);
        this.context.log.appendLine(
          `[CustomModelPricingHandler] Persisted ${Object.keys(windows).length} Codex context windows`,
        );
      }

      this.context.log.appendLine(
        `[CustomModelPricingHandler] Persisted ${Object.keys(pricingMap).length} pricing entries for ${provider}`,
      );
    } catch (error) {
      this.context.log.appendLine(`[CustomModelPricingHandler] Failed to handle ${event}: ${String(error)}`);
    }
    return true;
  }
}
