# Claude Code GUI

[中文文档](./README.zh-CN.md)

A Visual Studio Code extension that provides a graphical user interface for Claude Code CLI. It brings AI-powered coding assistance directly into your VSCode workspace with an intuitive chat interface, supporting both Claude (Anthropic) and Codex (OpenAI) models.

## Features

- **Dual AI Support**: Seamlessly switch between Claude and Codex models
- **Interactive Chat Interface**: Modern, responsive chat UI with markdown and code highlighting
- **Context-Aware**: Automatically syncs active file and selection context
- **Rich Tool Visualization**: Visual representation of file operations, bash commands, and more
- **Multi-language UI**: English, Chinese, Japanese, Korean, French, Spanish, Russian, Hindi
- **Quick Actions**:
  - Send code selections to Claude with `Cmd/Ctrl+Shift+C`
  - Generate commit messages from git changes
  - Quick fix errors with AI assistance
- **Permission Management**: Fine-grained control over AI tool permissions
- **Usage Tracking**: Monitor token usage and costs across sessions
- **MCP Integration**: Support for Model Context Protocol servers

## Prerequisites

- **Node.js** >= 18
- **VSCode** >= 1.85.0
- **AI SDK** (at least one):
  - Claude Agent SDK: `npm install -g @anthropic-ai/claude-agent-sdk`
  - Codex SDK: `npm install -g @openai/codex-sdk`

## Installation

### From Source

```bash
# Clone and install
git clone <repository-url>
cd vscode-cc-gui
npm install
cd webview && npm install && cd ..
cd ai-bridge && npm install && cd ..

# Build
npm run build

# Launch in VSCode: press F5
# Or package: npx vsce package
```

### From VSIX

1. Download the `.vsix` file
2. In VSCode: Extensions (`Cmd/Ctrl+Shift+X`) → `...` → `Install from VSIX...`

## Quick Start

1. Click the Claude Code GUI icon in the Activity Bar
2. Configure API keys in the settings panel
3. Start chatting — use `@filepath` to reference files, `Cmd/Ctrl+Shift+C` to send selections

## Project Structure

```
vscode-cc-gui/
├── src/                    # Extension source (TypeScript)
│   ├── extension.ts        # Entry point
│   ├── panel.ts            # Webview panel provider
│   ├── bridge.ts           # AI communication bridge
│   └── quickFix.ts         # Quick fix code action provider
├── webview/                # React + Vite + Ant Design webview UI
│   └── src/
├── ai-bridge/              # AI SDK bridge layer (Node.js daemon)
│   ├── daemon.js           # Bridge daemon process
│   ├── channels/           # Claude & Codex channels
│   └── services/           # AI service implementations
├── media/                  # Extension icons
└── dist/                   # Compiled extension output
```

## Development

```bash
# Build extension only
npm run build:ext

# Build webview only
npm run build:webview

# Build everything
npm run build

# Watch mode (extension)
npm run dev

# Run webview tests
cd webview && npm test
```

### Debugging

1. Open the project in VSCode
2. Press `F5` — launches Extension Development Host
3. Set breakpoints in `src/` for extension code
4. Use DevTools (Help → Toggle Developer Tools) for webview debugging

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Claude Code GUI: New Session` | — | Create a new chat session |
| `Claude Code GUI: Send Selection to Claude` | `Cmd/Ctrl+Shift+C` | Send selected code to chat |
| `Claude Code GUI: Send File Path to Claude` | — | Insert file path reference |
| `Claude Code GUI: Generate Commit Message` | — | AI-generated commit message |
| `Claude Code GUI: Fix with Claude` | — | Quick fix for diagnostics |

## Building for Production

```bash
# Install dependencies
npm install
cd webview && npm install && cd ..
cd ai-bridge && npm install && cd ..

# Build the project
npm run build

# Package as .vsix
npx vsce package --no-dependencies
# Output: claude-code-gui-<version>.vsix
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension not loading | Check VSCode >= 1.85.0, run `npm run build`, check Output panel |
| Webview shows "Building webview..." | Run `npm run build:webview` |
| AI not responding | Verify API keys, check `npm list -g`, review Output panel |
| Node.js not found | Set `claudeCodeGui.nodePath` in settings |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes and add tests
4. Submit a pull request

## License

See LICENSE file for details.
