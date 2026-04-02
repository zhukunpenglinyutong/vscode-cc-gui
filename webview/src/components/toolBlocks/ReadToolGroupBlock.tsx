import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { getToolLineInfo, resolveToolTarget } from '../../utils/toolPresentation';

interface FileItem {
  filePath: string;
  displayPath: string;
  cleanFileName: string;
  openPath: string;
  isDirectory: boolean;
  lineInfo?: string;
  lineStart?: number;
  lineEnd?: number;
  isCompleted: boolean;
  isError: boolean;
}

interface ReadToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 28;

/**
 * Parse item to FileItem
 */
const parseFileItem = (item: { input?: ToolInput; result?: ToolResultBlock | null }): FileItem | null => {
  const input = item.input;
  if (!input) return null;

  const target = resolveToolTarget(input, 'read');
  if (!target) return null;

  const lineInfoValue = getToolLineInfo(input, target);
  const lineInfo = lineInfoValue.start
    ? (lineInfoValue.end && lineInfoValue.end !== lineInfoValue.start
      ? `L${lineInfoValue.start}-${lineInfoValue.end}`
      : `L${lineInfoValue.start}`)
    : '';

  // Determine completion status
  const isCompleted = item.result !== undefined && item.result !== null;
  const isError = isCompleted && item.result?.is_error === true;

  return {
    filePath: target.rawPath,
    displayPath: target.displayPath,
    cleanFileName: target.cleanFileName,
    openPath: target.openPath,
    isDirectory: target.isDirectory,
    lineInfo,
    lineStart: lineInfoValue.start,
    lineEnd: lineInfoValue.end,
    isCompleted,
    isError,
  };
};

/**
 * Get file icon SVG by file name (with extension).
 */
const getFileIconSvg = (fileName: string, isDirectory: boolean) => {
  if (isDirectory) {
    return getFolderIcon(fileName.replace(/\/$/, ''));
  }
  const cleanName = fileName.replace(/:\d+(-\d+)?$/, '');
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : '';
  return getFileIcon(extension ?? '', cleanName);
};

const ReadToolGroupBlock = ({ items }: ReadToolGroupBlockProps) => {
  // Default to expanded
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items to file items
  const fileItems = useMemo(() => {
    return items
      .map(item => parseFileItem(item))
      .filter((item): item is FileItem => item !== null);
  }, [items]);

  // Auto-scroll to bottom when new items are added (streaming)
  useEffect(() => {
    if (listRef.current && fileItems.length > prevItemCountRef.current) {
      // New item added, scroll to bottom
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = fileItems.length;
  }, [fileItems.length]);

  if (fileItems.length === 0) {
    return null;
  }

  // Calculate list height: show up to MAX_VISIBLE_ITEMS, scroll for more
  const needsScroll = fileItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : fileItems.length * ITEM_HEIGHT;

  const handleFileClick = (openPath: string, isDirectory: boolean, e: React.MouseEvent, lineStart?: number, lineEnd?: number) => {
    e.stopPropagation();
    if (!isDirectory) {
      openFile(openPath, lineStart, lineEnd);
    }
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section" style={{ overflow: 'hidden' }}>
          <span className="codicon codicon-file-code tool-title-icon" />
          <span className="tool-title-text" style={{ flexShrink: 0 }}>
            {t('permission.tools.ReadBatch')}
          </span>
          <span className="tool-title-summary" style={{
            color: 'var(--text-secondary)',
            marginLeft: '4px',
            flexShrink: 0,
          }}>
            ({fileItems.length})
          </span>
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={{
            padding: '6px 8px',
            border: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            maxHeight: `${listHeight + 12}px`, // +12 for padding
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {fileItems.map((item, index) => (
            <div
              key={index}
              className={`file-list-item ${!item.isDirectory ? 'clickable-file' : ''}`}
              onClick={(e) => handleFileClick(item.openPath, item.isDirectory, e, item.lineStart, item.lineEnd)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: item.isDirectory ? 'default' : 'pointer',
                transition: 'background-color 0.15s ease',
                minHeight: `${ITEM_HEIGHT}px`,
                flexShrink: 0,
              }}
              title={item.displayPath}
            >
              <span
                style={{
                  marginRight: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  width: '16px',
                  height: '16px',
                  flexShrink: 0,
                }}
                dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.cleanFileName, item.isDirectory) }}
              />
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {item.displayPath}
              </span>
              {item.lineInfo && (
                <span
                  style={{
                    marginLeft: '8px',
                    fontSize: '11px',
                    color: 'var(--text-tertiary, var(--text-secondary))',
                    flexShrink: 0,
                    opacity: 0.8,
                  }}
                >
                  {item.lineInfo}
                </span>
              )}
              {/* Status indicator */}
              <div
                className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
                style={{ marginLeft: '8px' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReadToolGroupBlock;
