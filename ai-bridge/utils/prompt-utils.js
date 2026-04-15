/**
 * Shared prompt utility functions.
 */

/**
 * Build the Windows path format constraint prompt section.
 * Only returns content on Windows platform (process.platform === 'win32').
 *
 * @param {Object} [options] - Options
 * @param {string} [options.extra] - Additional instruction text appended after the base message
 * @returns {string} The constraint prompt section, or empty string on non-Windows
 */
export function getWindowsPathConstraint(options = {}) {
  if (process.platform !== 'win32') {
    return '';
  }

  const { extra = '' } = options;
  const extraText = extra ? ` ${extra}` : '';

  let text = '\n\n## CRITICAL: File Path Format Requirement\n\n';
  text += `**IMPORTANT**: There's a file modification bug in Claude Code. The workaround is: always use complete absolute Windows paths with drive letters and backslashes for ALL file operations.${extraText}\n\n`;
  text += '**Examples**:\n';
  text += '- \u2705 Correct: `C:\\Users\\username\\project\\src\\file.js`\n';
  text += '- \u274C Wrong: `/c/Users/username/project/src/file.js`\n';
  text += '- \u274C Wrong: `./src/file.js` (relative paths)\n\n';
  text += '---\n\n';

  return text;
}
