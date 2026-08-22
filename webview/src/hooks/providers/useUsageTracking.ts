import { useCallback, useState } from 'react';
import { CLI_ONLY_PROVIDERS } from './cliProviders';

const PROVIDER_TO_SDK: Record<string, string> = {
  claude: 'claude-sdk',
  anthropic: 'claude-sdk',
  bedrock: 'claude-sdk',
  codex: 'codex-sdk',
  openai: 'codex-sdk',
  grok: 'grok-cli',
  kimi: 'kimi-cli',
  opencode: 'opencode-cli',
  pi: 'pi-cli',
};

type SdkStatus = Record<string, { installed?: boolean; status?: string }>;

/**
 * Usage % / token counters and SDK install status. `isSdkInstalled(providerId)`
 * is exposed as a stable callback for callers that need to gate UI on SDK
 * availability. The sdkStatusLoaded flag must be true before queries return
 * meaningful results.
 */
export function useUsageTracking() {
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [sdkStatus, setSdkStatus] = useState<SdkStatus>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false);

  const isSdkInstalled = useCallback(
    (providerId: string): boolean => {
      // Headless CLI providers are system-installed; do not gate on SDK status.
      if (CLI_ONLY_PROVIDERS.has(providerId)) return true;
      if (!sdkStatusLoaded) return false;
      const sdkId = PROVIDER_TO_SDK[providerId] || 'claude-sdk';
      const status = sdkStatus[sdkId];
      return status?.status === 'installed' || status?.installed === true;
    },
    [sdkStatusLoaded, sdkStatus],
  );

  return {
    usagePercentage,
    setUsagePercentage,
    usageUsedTokens,
    setUsageUsedTokens,
    usageMaxTokens,
    setUsageMaxTokens,
    sdkStatus,
    setSdkStatus,
    sdkStatusLoaded,
    setSdkStatusLoaded,
    isSdkInstalled,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
