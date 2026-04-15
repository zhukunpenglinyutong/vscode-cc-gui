/**
 * File icon mapping utility
 * Returns inline SVG strings to support vite-plugin-singlefile bundling
 *
 * Data tables are in ./fileIconMaps.ts
 */

import {
  FILE_NAME_MAP,
  EXTENSION_MAP,
  FOLDER_NAME_MAP,
  TOOL_NAME_MAP,
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  TEST_FILE_ICON,
} from './fileIconMaps';

/**
 * Get icon SVG by file extension
 */
export function getFileIcon(extension?: string, fileName?: string): string {
  // 1. Match by filename first
  if (fileName) {
    const name = fileName.toLowerCase();
    if (FILE_NAME_MAP[name]) {
      return FILE_NAME_MAP[name];
    }

    // Check for test files
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.test.js') || name.endsWith('.test.jsx') ||
        name.endsWith('.spec.ts') || name.endsWith('.spec.tsx') || name.endsWith('.spec.js') || name.endsWith('.spec.jsx')) {
      return TEST_FILE_ICON;
    }
  }

  if (!extension) {
    return DEFAULT_FILE_ICON;
  }

  const ext = extension.toLowerCase();
  return EXTENSION_MAP[ext] || DEFAULT_FILE_ICON;
}

/**
 * Get icon SVG by folder name
 */
export function getFolderIcon(folderName: string, isOpen: boolean = false): string {
  const name = folderName.toLowerCase();

  // Generic open folder
  if (isOpen && !FOLDER_NAME_MAP[name]) {
    return DEFAULT_FOLDER_OPEN_ICON;
  }

  return FOLDER_NAME_MAP[name] || DEFAULT_FOLDER_ICON;
}

/**
 * Get tool/framework icon SVG
 */
export function getToolIcon(toolName: string): string {
  return TOOL_NAME_MAP[toolName.toLowerCase()] || DEFAULT_FILE_ICON;
}
