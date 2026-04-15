import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { getToolLineInfo, resolveToolTarget } from '../../utils/toolPresentation';

interface ReadToolBlockProps {
  input?: ToolInput;
}

const ReadToolBlock = ({ input }: ReadToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  if (!input) {
    return null;
  }

  const target = resolveToolTarget(input, 'read');
  const filePath = target?.rawPath;
  const lineInfo = getToolLineInfo(input, target);
  const isDirectory = target?.isDirectory ?? false;
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';
  const actionText = isDirectory ? t('permission.tools.readDirectory') : t('permission.tools.Read');

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling to avoid triggering expand/collapse
    if (target?.isFile) {
      openFile(target.openPath, lineInfo.start, lineInfo.end);
    }
  };

  const getFileIconSvg = () => {
    if (!target) return '';
    if (isDirectory) {
      return getFolderIcon(target.cleanFileName);
    }
    const extension = target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '';
    return getFileIcon(extension ?? '', target.cleanFileName);
  };

  // Get all input parameters for the expanded view, excluding Codex-specific fields
  const params = Object.entries(input).filter(([key]) =>
    key !== 'file_path' &&
    key !== 'target_file' &&
    key !== 'path' &&
    key !== 'command' &&    // Omit Codex command field
    key !== 'workdir' &&    // Omit Codex workdir field
    key !== 'description'   // Omit Codex description field
  );

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section">
          <span className={`codicon ${iconClass} tool-title-icon`} />

          <span className="tool-title-text">
            {actionText}
          </span>
          <span
            className={`tool-title-summary ${!isDirectory ? 'clickable-file' : ''}`}
            onClick={!isDirectory ? handleFileClick : undefined}
            title={!isDirectory ? t('tools.clickToOpen', { filePath }) : undefined}
            style={{ display: 'flex', alignItems: 'center' }}
          >
            <span
              style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }}
              dangerouslySetInnerHTML={{ __html: getFileIconSvg() }}
            />
            {target?.displayPath || filePath}
          </span>

          {lineInfo.start && (
            <span className="tool-title-summary" style={{ marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo.end && lineInfo.end !== lineInfo.start
                ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
                : t('tools.lineSingle', { line: lineInfo.start })}
            </span>
          )}
        </div>

        <div className="tool-status-indicator completed" />
      </div>

      {expanded && params.length > 0 && (
        <div className="task-details" style={{ padding: '12px', border: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontFamily: 'var(--idea-editor-font-family, monospace)',
              fontSize: '12px',
            }}
          >
            {params.map(([key, value]) => (
              <div
                key={key}
                style={{
                  color: '#858585',
                  display: 'flex',
                  alignItems: 'baseline',
                  overflow: 'hidden'
                }}
              >
                <span style={{ color: '#90caf9', fontWeight: 600, flexShrink: 0 }}>{key}：</span>
                <span
                  style={{
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                    flex: 1
                  }}
                >
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadToolBlock;
