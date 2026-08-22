import * as fs from 'fs';
import * as path from 'path';

/**
 * Claude Code stores background-agent transcripts at:
 *   <projectsDir>/<project>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 */
export function buildSubagentSidechainFileName(agentId: string): string {
  const normalized = String(agentId || '').trim();
  if (!normalized) return '';
  return normalized.startsWith('agent-') ? `${normalized}.jsonl` : `agent-${normalized}.jsonl`;
}

export function resolveSubagentSidechainFile(
  projectsDir: string,
  projectDirs: string[],
  parentSessionId: string,
  agentId: string,
): string | null {
  const fileName = buildSubagentSidechainFileName(agentId);
  if (!fileName || !parentSessionId) return null;
  for (const projectDir of projectDirs) {
    const candidate = path.join(projectsDir, projectDir, parentSessionId, 'subagents', fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A sidechain is complete when a trailing assistant message ends with
 * stop_reason end_turn (or stop_sequence). Intermediate tool_use stops mean
 * the agent is still working.
 */
export function isSubagentSidechainCompletedFromJsonl(fileContents: string): boolean {
  const lines = fileContents.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]) as {
        type?: string;
        stop_reason?: string;
        message?: { stop_reason?: string };
      };
      if (row?.type !== 'assistant') continue;
      const stop = row?.message?.stop_reason ?? row?.stop_reason;
      if (stop === 'end_turn' || stop === 'stop_sequence') return true;
      if (stop === 'tool_use') return false;
    } catch {
      // skip malformed line
    }
  }
  return false;
}
