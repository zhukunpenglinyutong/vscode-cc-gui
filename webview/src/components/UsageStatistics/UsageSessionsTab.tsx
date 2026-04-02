import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '../../types/usage';

interface SessionsTabProps {
  filteredSessions: SessionSummary[];
  paginatedSessions: SessionSummary[];
  sessionPage: number;
  totalPages: number;
  sessionsPerPage: number;
  sessionSortBy: 'cost' | 'time';
  setSessionPage: React.Dispatch<React.SetStateAction<number>>;
  setSessionSortBy: React.Dispatch<React.SetStateAction<'cost' | 'time'>>;
  formatDate: (timestamp: number) => string;
  formatCost: (cost: number) => string;
  formatNumber: (num: number) => string;
}

export const UsageSessionsTab = ({
  filteredSessions, paginatedSessions,
  sessionPage, totalPages, sessionsPerPage,
  sessionSortBy, setSessionPage, setSessionSortBy,
  formatDate, formatCost, formatNumber,
}: SessionsTabProps) => {
  const { t } = useTranslation();

  return (
    <div className="sessions-tab">
      <div className="sessions-header">
        <h4>{t('usage.sessionList')} ({filteredSessions.length})</h4>
        <div className="sort-buttons">
          <button
            className={`sort-btn ${sessionSortBy === 'cost' ? 'active' : ''}`}
            onClick={() => setSessionSortBy('cost')}
          >
            {t('usage.sortByCost')}
          </button>
          <button
            className={`sort-btn ${sessionSortBy === 'time' ? 'active' : ''}`}
            onClick={() => setSessionSortBy('time')}
          >
            {t('usage.sortByTime')}
          </button>
        </div>
      </div>

      <div className="sessions-list">
        {paginatedSessions.map((session, index) => (
          <div key={session.sessionId} className="session-item">
            <div className="session-rank">
              {(sessionPage - 1) * sessionsPerPage + index + 1}
            </div>
            <div className="session-info">
              <div className="session-title">
                {session.summary || session.sessionId}
              </div>
              {session.summary && (
                <div className="session-id-small">{session.sessionId}</div>
              )}
              <div className="session-meta">
                <span>{formatDate(session.timestamp)}</span>
                <span className="separator">•</span>
                <span>{session.model}</span>
                <span className="separator">•</span>
                <span>{formatNumber(session.usage.totalTokens)} tokens</span>
              </div>
            </div>
            <div className="session-cost">{formatCost(session.cost)}</div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button
            onClick={() => setSessionPage(p => Math.max(1, p - 1))}
            disabled={sessionPage === 1}
            className="page-btn"
          >
            <span className="codicon codicon-chevron-left" />
          </button>
          <span className="page-info">
            {sessionPage} / {totalPages}
          </span>
          <button
            onClick={() => setSessionPage(p => Math.min(totalPages, p + 1))}
            disabled={sessionPage === totalPages}
            className="page-btn"
          >
            <span className="codicon codicon-chevron-right" />
          </button>
        </div>
      )}
    </div>
  );
};
