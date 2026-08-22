import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson } from './helpers';
import { codemossConfigPath } from '../services/codemossJsonStore';
import { MCP_MARKETPLACE_SOURCES, McpMarketplaceService } from '../services/mcpMarketplaceClient';
import { fetchMcpMarketplaceJson } from '../services/mcpMarketplaceHttp';
import { parseCopilotMcpConfig } from '../services/copilotMcpImport';

interface SearchMarketplaceRequest {
  query?: string;
  sourceId?: string;
  forceRefresh?: boolean;
}

interface ParseCopilotConfigRequest {
  json?: string;
  isCodexMode?: boolean;
}

/**
 * MCP server marketplace discovery (built-in presets + the official/GitHub MCP registries +
 * the modelcontextprotocol GitHub org) and the GitHub Copilot MCP config importer. Both
 * features are read-only discovery/preview: persisting an installed/imported server stays on
 * the existing `McpServerHandler` add/save path.
 */
export class McpMarketplaceHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_mcp_marketplace_sources',
    'search_mcp_marketplace',
    'parse_copilot_mcp_config',
  ] as const;

  private readonly marketplaceService: McpMarketplaceService;

  constructor(private readonly context: BridgeContext, marketplaceService?: McpMarketplaceService) {
    this.marketplaceService = marketplaceService ?? new McpMarketplaceService({
      cacheDir: codemossConfigPath('mcp-marketplace-cache'),
      fetchJson: fetchMcpMarketplaceJson,
    });
  }

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'get_mcp_marketplace_sources':
        callWindowFunction(webview, 'updateMcpMarketplaceSources', MCP_MARKETPLACE_SOURCES);
        return true;

      case 'search_mcp_marketplace': {
        const request = parseJson<SearchMarketplaceRequest>(content, {});
        const query = request.query ?? '';
        const sourceId = request.sourceId ?? 'all';
        this.marketplaceService.search(query, sourceId, !!request.forceRefresh)
          .then(({ entries, error }) => {
            callWindowFunction(webview, 'updateMcpMarketplaceEntries', {
              query,
              sourceId,
              entries,
              ...(error ? { error } : {}),
            });
          })
          .catch((error) => {
            callWindowFunction(webview, 'updateMcpMarketplaceEntries', {
              query,
              sourceId,
              entries: [],
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return true;
      }

      case 'parse_copilot_mcp_config': {
        const request = parseJson<ParseCopilotConfigRequest>(content, {});
        const result = parseCopilotMcpConfig(request.json ?? '', !!request.isCodexMode);
        callWindowFunction(webview, 'updateCopilotImportPreview', result);
        return true;
      }

      default:
        return false;
    }
  }
}
