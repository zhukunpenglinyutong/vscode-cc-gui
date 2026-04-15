import { useState, useCallback, useEffect } from 'react';
import App from './App';

interface Tab {
  id: string;
  label: string;
}

let tabCounter = 1;

const TabManager = () => {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'tab-1', label: 'AI1' }]);
  const [activeTabId, setActiveTabId] = useState('tab-1');

  const addTab = useCallback(() => {
    tabCounter += 1;
    const id = `tab-${tabCounter}`;
    const label = `AI${tabCounter}`;
    setTabs(prev => [...prev, { id, label }]);
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      if (prev.length === 1) return prev; // keep at least one tab
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      setActiveTabId(cur => {
        if (cur !== id) return cur;
        // activate adjacent tab
        return (next[idx] ?? next[idx - 1])?.id ?? next[0].id;
      });
      return next;
    });
  }, []);

  // Listen for create_new_tab from bridge (via window event)
  useEffect(() => {
    const handler = () => addTab();
    window.addEventListener('__ccg_new_tab', handler);
    return () => window.removeEventListener('__ccg_new_tab', handler);
  }, [addTab]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar — only show when more than one tab */}
      {tabs.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          padding: '4px 8px 0', background: 'var(--vscode-sideBar-background, #1e1e1e)',
          borderBottom: '1px solid var(--vscode-panel-border, #333)', flexShrink: 0,
          overflowX: 'auto',
        }}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: '4px 4px 0 0', cursor: 'pointer',
                fontSize: 12, userSelect: 'none', whiteSpace: 'nowrap',
                background: tab.id === activeTabId
                  ? 'var(--vscode-tab-activeBackground, #252526)'
                  : 'var(--vscode-tab-inactiveBackground, #2d2d2d)',
                color: tab.id === activeTabId
                  ? 'var(--vscode-tab-activeForeground, #fff)'
                  : 'var(--vscode-tab-inactiveForeground, #999)',
                borderTop: tab.id === activeTabId ? '1px solid var(--vscode-focusBorder, #007acc)' : '1px solid transparent',
              }}
            >
              <span>{tab.label}</span>
              <span
                onClick={(e) => closeTab(tab.id, e)}
                style={{
                  fontSize: 10, opacity: 0.6, lineHeight: 1,
                  padding: '0 2px', borderRadius: 2,
                }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
              >✕</span>
            </div>
          ))}
        </div>
      )}

      {/* Tab content — keep all mounted, toggle visibility */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            style={{
              position: 'absolute', inset: 0,
              display: tab.id === activeTabId ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            <App tabId={tab.id} onNewTab={addTab} />
          </div>
        ))}
      </div>
    </div>
  );
};

export default TabManager;
