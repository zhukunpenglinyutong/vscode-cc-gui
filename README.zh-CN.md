# Claude Code GUI

[English](./README.md)

一个 Visual Studio Code 扩展，为 Claude Code CLI 提供图形用户界面。它将 AI 驱动的编码辅助直接集成到你的 VSCode 工作区，提供直观的聊天界面，支持 Claude（Anthropic）和 Codex（OpenAI）模型。

## 功能特性

- **双 AI 支持**：在 Claude 和 Codex 模型之间无缝切换
- **交互式聊天界面**：现代化、响应式的聊天 UI，支持 Markdown 和代码高亮
- **上下文感知**：自动同步当前活动文件和选中内容
- **丰富的工具可视化**：文件操作、bash 命令等的可视化展示
- **多语言 UI**：支持英语、中文、日语、韩语、法语、西班牙语、俄语、印地语
- **快捷操作**：
  - 使用 `Cmd/Ctrl+Shift+C` 将选中代码发送给 Claude
  - 从 git 变更自动生成提交消息
  - AI 辅助快速修复代码错误
- **权限管理**：对 AI 工具权限的细粒度控制
- **使用量追踪**：监控跨会话的 token 使用量和费用
- **MCP 集成**：支持模型上下文协议（Model Context Protocol）服务器

## 前置要求

- **Node.js** >= 18
- **VSCode** >= 1.85.0
- **AI SDK**（至少安装一个）：
  - Claude Agent SDK：`npm install -g @anthropic-ai/claude-agent-sdk`
  - Codex SDK：`npm install -g @openai/codex-sdk`

## 安装

### 从源码安装

```bash
# 克隆并安装依赖
git clone <repository-url>
cd vscode-cc-gui
npm install
cd webview && npm install && cd ..
cd ai-bridge && npm install && cd ..

# 构建
npm run build

# 在 VSCode 中启动：按 F5
# 或打包安装：npx vsce package
```

### 从 VSIX 安装

1. 下载 `.vsix` 文件
2. 在 VSCode 中：扩展（`Cmd/Ctrl+Shift+X`）→ `...` → `从 VSIX 安装...`

## 快速开始

1. 点击活动栏中的 Claude Code GUI 图标
2. 在设置面板中配置 API 密钥
3. 开始聊天 — 使用 `@filepath` 引用文件，`Cmd/Ctrl+Shift+C` 发送选中代码

## 项目结构

```
vscode-cc-gui/
├── src/                    # 扩展源代码（TypeScript）
│   ├── extension.ts        # 入口文件
│   ├── panel.ts            # Webview 面板提供者
│   ├── bridge.ts           # AI 通信桥接服务
│   └── quickFix.ts         # 快速修复代码操作提供者
├── webview/                # React + Vite + Ant Design webview 界面
│   └── src/
├── ai-bridge/              # AI SDK 桥接层（Node.js 守护进程）
│   ├── daemon.js           # 桥接守护进程
│   ├── channels/           # Claude 和 Codex 通道
│   └── services/           # AI 服务实现
├── media/                  # 扩展图标资源
└── dist/                   # 编译后的扩展输出
```

## 开发

```bash
# 仅构建扩展
npm run build:ext

# 仅构建 webview
npm run build:webview

# 构建所有内容
npm run build

# 监视模式（扩展）
npm run dev

# 运行 webview 测试
cd webview && npm test
```

### 调试

1. 在 VSCode 中打开项目
2. 按 `F5` — 启动扩展开发主机（Extension Development Host）
3. 在 `src/` 目录下的文件中设置断点调试扩展代码
4. 使用开发者工具（帮助 → 切换开发者工具）调试 webview

## 命令列表

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `Claude Code GUI: New Session` | — | 创建新的聊天会话 |
| `Claude Code GUI: Send Selection to Claude` | `Cmd/Ctrl+Shift+C` | 将选中代码发送到聊天 |
| `Claude Code GUI: Send File Path to Claude` | — | 插入文件路径引用 |
| `Claude Code GUI: Generate Commit Message` | — | AI 生成提交消息 |
| `Claude Code GUI: Fix with Claude` | — | 快速修复诊断错误 |

## 生产构建

```bash
# 安装依赖
npm install
cd webview && npm install && cd ..
cd ai-bridge && npm install && cd ..

# 构建项目
npm run build

# 打包为 .vsix
npx vsce package --no-dependencies
# 输出文件：claude-code-gui-<version>.vsix
```

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 扩展无法加载 | 检查 VSCode >= 1.85.0，运行 `npm run build`，查看输出面板 |
| Webview 显示 "Building webview..." | 运行 `npm run build:webview` |
| AI 无响应 | 检查 API 密钥配置，运行 `npm list -g` 确认 SDK，查看输出面板 |
| 找不到 Node.js | 在设置中配置 `claudeCodeGui.nodePath` |

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 提交更改并添加测试
4. 提交 Pull Request

## 许可证

详见 LICENSE 文件。
