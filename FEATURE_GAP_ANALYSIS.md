# VSCode vs JetBrains 功能差异分析报告

> 参考工程：`/Users/hamster.huang/Desktop/mycode/jetbrains-cc-gui`（Java/Kotlin）
> 当前工程：`/Users/hamster.huang/Desktop/mycode/vscode-cc-gui`（TypeScript）
> 分析日期：2026-04-17

---

## 一、后端 bridge.ts 缺失的处理器

> UI 已有，但后端未实现 → 操作无任何效果

### 1.1 MCP 服务器 CRUD（完全缺失）

| 缺失命令 | 功能 |
|---|---|
| `add_mcp_server` / `add_codex_mcp_server` | 添加 MCP 服务器 |
| `update_mcp_server` / `update_codex_mcp_server` | 更新 MCP 服务器配置 |
| `delete_mcp_server` / `delete_codex_mcp_server` | 删除 MCP 服务器 |
| `toggle_mcp_server` / `toggle_codex_mcp_server` | 启用 / 禁用服务器 |
| `get_mcp_server_tools` / `get_codex_mcp_server_tools` | 获取服务器工具列表 |

**现象**：MCP 设置页面打开正常，但添加/编辑/删除/Toggle 操作全部无响应，工具列表面板空白。

### 1.2 依赖版本管理

| 缺失命令 | 功能 |
|---|---|
| `get_dependency_versions` | 获取 SDK 可选版本列表 |

**现象**：依赖管理页版本下拉选择器为空，无法指定版本安装。

### 1.3 输入历史持久化

| 缺失命令 | 功能 |
|---|---|
| `get_input_history` | 加载历史输入记录 |
| `record_input_history` | 保存输入片段 |
| `delete_input_history_item` | 删除单条历史 |
| `clear_input_history` | 清空所有历史 |

**现象**：输入框 ↑ 键回溯无历史；设置 → 其他 → 输入历史管理无数据。

### 1.4 其他缺失命令

| 缺失命令 | 功能 | 优先级 |
|---|---|---|
| `get_ide_theme` | 获取 IDE 当前主题 light/dark | P2 |
| `get_status_bar_widget` / `set_status_bar_widget` | 状态栏组件显隐 | P2 |
| `set_reasoning_effort` | 设置 Claude 推理力度 | P2 |
| `get_commit_generation_enabled` / `set_commit_generation_enabled` | Commit 生成功能开关 | P2 |

---

## 二、Webview 缺失的工具文件

> 文件在 JetBrains 版本存在，VS Code 版本完全没有

| 缺失文件 | 位置 | 功能 | 影响 |
|---|---|---|---|
| `diffTheme.ts` | `webview/src/utils/` | Diff 视图主题（light/dark/soft-dark） | Diff 颜色不正确 |
| `toolInputNormalization.ts` | `webview/src/utils/` | 标准化 edit_file/write_file/update_plan/spawn_agent 参数 | 工具调用参数不兼容 |
| `turnScope.ts` | `webview/src/utils/` | 当前轮次截取、Todo/Subagent 最终化 | Todo 停留 in_progress |
| `todoShared.ts` | `webview/src/utils/` | Todo 状态归一化（done→completed, active→in_progress） | Todo 状态解析错误 |
| `todoToolNormalization.ts` | `webview/src/utils/` | 从 todowrite/update_plan 提取 Todo 列表 | update_plan 的 Todo 不显示 |
| `parseSequence.ts` | `webview/src/hooks/windowCallbacks/` | 解析消息序列号 | 乱序消息可能被渲染 |

---

## 三、Webview 核心逻辑降级

> 文件存在但缺少 JetBrains 版的关键逻辑

### 3.1 `messageCallbacks.ts` — streaming 性能

**缺失逻辑：**
- **RAF 缓冲机制**：用 `requestAnimationFrame` 批处理 `updateMessages`，防止 streaming 时主线程卡顿（假冻结）
- **序列号过滤**：丢弃 `sequence < minAccepted` 的过期消息，防止乱序显示
- **`getStructuralRawBlockSignature`**：轻量化 tool_use/tool_result 变更检测
- **`cancelPendingUpdateMessages`**：stream 结束时取消挂起的 RAF 更新，防止 stale 覆盖

**症状**：大量消息流式输出时界面假冻结；stream 结束后消息状态有时被旧数据覆盖。

### 3.2 `streamingCallbacks.ts` — 流稳定性

**缺失逻辑：**
- **Stream stall watchdog（60s 超时）**：backend `onStreamEnd` 信号丢失时，前端自动清理 streaming 状态
- **`appendNovelTextLikeBlock`**：流式文本去重合并，防止内容重复渲染
- **`preferMoreCompleteText/Thinking`**：保留已接收的最长文本
- **`mergeStreamingTextLikeContent`**：带重叠检测的文本拼接
- **`onStreamingHeartbeat()`**：工具执行期间保活信号（防止误判超时）

**症状**：AI 执行长时间工具（如 npm install）时，60s 后 loading 消失；thinking 内容出现重复。

### 3.3 `messageSync.ts` — Codex 消息稳定性

**缺失逻辑：**
- **`stripDuplicateTrailingToolMessages`**：去除 Codex 模式下尾部重复的 tool_use 消息
- **`preserveLatestMessagesOnShrink`**：Codex 对话压缩时，保留本地最新消息防止界面闪烁

**症状**：Codex 模式下工具调用后出现重复消息；长对话被压缩时最新内容消失。

### 3.4 `App.tsx` — 命令与状态管理

**缺失逻辑：**
- 启动时调用 `applyDiffTheme(getStoredDiffTheme(), ideTheme)` 初始化 diff 主题
- `/resume`、`/continue` 命令 → 跳转历史记录视图
- `/plan` 命令 → 切换 plan 模式（Codex 下显示不支持提示）
- 使用 `extractTodosFromToolUse`（支持 `update_plan` 工具的 Todo）
- 使用 `finalizeTodosForSettledTurn`（streaming 结束时将 in_progress → completed）
- 使用 `finalizeSubagentsForSettledTurn`（同上，针对子代理）
- 使用 `sliceLatestConversationTurn`（只显示最新轮次的 Todo，不累积历史）

### 3.5 `useMessageSender.ts` — Slash 命令

**缺失逻辑：**
- 导出 `RESUME_COMMANDS = new Set(['/resume', '/continue'])`
- 导出 `PLAN_COMMANDS = new Set(['/plan'])`
- `checkLocalCommand`：本地处理 `/resume`（打开历史视图）和 `/plan`（切换模式）

**症状**：输入 `/resume`、`/continue`、`/plan` 回车后无任何响应。

### 3.6 `useSubagents.ts` — 子代理识别

**缺失逻辑：**
- `normalizeToolInput` 标准化子代理 input 字段（`subagent_type`、`prompt`、`description`）
- 识别 `spawn_agent` 工具名（当前只识别 `task` 和 `agent`）
- 独立函数 `extractSubagentsFromMessages`（可在 hook 外复用）

**症状**：AI 调用 `spawn_agent` 工具时子代理面板不显示。

### 3.7 `messageUtils.ts` — 消息合并

**缺失逻辑（更智能的 assistant 消息合并）：**
- `shouldMergeAssistantMessage`：按 `__turnId` 和 tool_use/text 类型边界决定是否合并
- `isToolResultOnlyUserMessage`：跳过中间夹着的 tool_result user 消息
- 不同 turnId 的相邻 assistant 消息不合并；tool_use 与纯文本 assistant 消息不合并

**症状**：历史记录中 tool_use 块和回复文字被错误合并；不同轮次消息串在一起。

### 3.8 `DependencySection` — 版本管理 UI

**缺失逻辑：**
- `versioning.ts`（`compareVersions`、`buildVersionOptions`、`getVersionAction`）
- 版本选择下拉 UI（显示可安装的历史版本）
- `dependencyVersionsLoaded` window 回调处理
- 安装/更新时携带指定版本号

**症状**：依赖管理只能安装最新版，无法降级或指定版本；版本下拉为空。

---

## 四、缺失的 Window Callback

| 缺失回调 | 功能 |
|---|---|
| `dependencyInstallProgress(json)` | 安装过程实时日志输出 |
| `dependencyUninstallResult(json)` | 卸载结果回调 |
| `dependencyUpdateAvailable(json)` | SDK 有新版本通知 |
| `nodeEnvironmentStatus(json)` | Node.js 检测结果（路径/版本/可用性） |
| `dependencyVersionsLoaded(json)` | 可选版本列表加载完成 |
| `onInputHistoryLoaded(json)` | 输入历史加载回调 |
| `onInputHistoryRecorded(json)` | 输入已记录确认 |
| `onClipboardRead(text)` | 剪贴板读取结果 |
| `onStreamingHeartbeat()` | 流式保活信号 |

---

## 五、JetBrains 独有功能（无需迁移）

| 功能 | 说明 |
|---|---|
| IDE 原生 Diff 查看器 | JetBrains 原生集成，VS Code 有自己的 diff |
| 声音通知播放 | VS Code 已有相关 UI，但实际播放依赖平台 |
| 独立浮动窗口（DetachTab） | JetBrains 特有 |
| 终端监控（TerminalMonitorService） | JetBrains 特有 |
| 运行配置监控（RunConfigMonitorService） | JetBrains 特有 |
| Java/Python 语言上下文收集 | JetBrains 特有 |

---

## 六、VS Code 独有功能（正确实现，无需对标）

| 功能 | 说明 |
|---|---|
| `TabManager.tsx` 本地多 Tab | VS Code 用本地状态管理 Tab，JetBrains 通过 bridge 创建 |
| `version/version.ts` | VS Code 版本管理 |
| contextInfo / tabId / runtimeSessionEpoch | 多 Tab 会话隔离机制 |
| acquireBridge / releaseBridge | Tab 消息路由锁 |

---

## 七、自测用例

> 🔴 P0 = 核心功能缺失，需优先修复
> 🟡 P1 = 稳定性问题，影响使用体验
> 🟢 P2 = 体验提升，可后续迭代

---

### 模块 1：MCP 服务器管理 🔴

| # | 测试用例 | 预期结果 |
|---|---|---|
| MCP-01 | 设置 → MCP → 点击"添加服务器"，填写 name/command/args 后保存 | 保存成功，列表出现新服务器 |
| MCP-02 | 点击编辑已有 MCP 服务器，修改参数后确认 | 配置更新，列表刷新 |
| MCP-03 | 点击删除 MCP 服务器 | 弹出确认框，确认后移除 |
| MCP-04 | Toggle 服务器启用/禁用开关 | 状态立即切换，出现 toast 提示 |
| MCP-05 | 展开服务器卡片，查看工具列表 | 显示该服务器暴露的 tool 列表 |
| MCP-06 | Codex 模式下重复上述 MCP 操作 | 所有操作同样有效 |
| MCP-07 | 使用预设 MCP 配置（McpPresetDialog） | 一键添加预设服务器成功 |
| MCP-08 | 查看 MCP 日志（McpLogDialog） | 显示服务器连接日志 |

---

### 模块 2：Todo 任务面板 🔴

| # | 测试用例 | 预期结果 |
|---|---|---|
| TODO-01 | AI 调用 `TodoWrite` 工具写入任务列表 | 右侧 Todo 面板显示任务 |
| TODO-02 | AI 调用 `update_plan` 工具更新计划 | Todo 面板同样展示（需 todoToolNormalization） |
| TODO-03 | Todo 的 status 字段值为 `done` | 解析为 `completed`（需 normalizeTodoStatus） |
| TODO-04 | Todo 的 status 字段值为 `active` 或 `running` | 解析为 `in_progress` |
| TODO-05 | Streaming 结束后仍有 `in_progress` 状态的 Todo | 自动变为 `completed`（需 finalizeTodosForSettledTurn） |
| TODO-06 | 新一轮对话开始后查看 Todo 面板 | 只显示最新轮次任务，历史任务不累积（需 sliceLatestConversationTurn） |

---

### 模块 3：Slash 命令 🔴

| # | 测试用例 | 预期结果 |
|---|---|---|
| SLASH-01 | 输入 `/new` 回车 | 创建新会话，消息区清空 |
| SLASH-02 | 输入 `/clear` 回车 | 清空当前会话 |
| SLASH-03 | 输入 `/resume` 回车 | 跳转到历史记录视图 |
| SLASH-04 | 输入 `/continue` 回车 | 同 `/resume`，跳转历史视图 |
| SLASH-05 | 输入 `/plan` 回车（Claude 模式） | 切换到 plan 模式，toast 提示"Plan mode enabled" |
| SLASH-06 | 输入 `/plan` 回车（Codex 模式） | toast 提示"Plan mode is not available for Codex" |
| SLASH-07 | 输入 `/` 触发自动补全下拉 | 显示可用命令列表 |

---

### 模块 4：Subagent 子代理面板 🔴

| # | 测试用例 | 预期结果 |
|---|---|---|
| SUB-01 | AI 调用 `Task` 工具 | 状态面板显示子代理，状态为 running |
| SUB-02 | AI 调用 `spawn_agent` 工具 | 同样识别并展示（需 normalizeToolInput） |
| SUB-03 | 子代理执行完成（有对应 tool_result） | 状态更新为 `completed` |
| SUB-04 | 子代理执行失败（tool_result 含 is_error） | 状态显示 `error` |
| SUB-05 | Streaming 结束后仍有 `running` 状态子代理 | 自动变 `completed`（需 finalizeSubagentsForSettledTurn） |

---

### 模块 5：Streaming 稳定性 🟡

| # | 测试用例 | 预期结果 |
|---|---|---|
| STREAM-01 | 发送消息，AI 正常流式输出文字 | 文字逐渐出现，界面不卡顿（需 RAF 缓冲） |
| STREAM-02 | Streaming 中包含 `thinking` 内容 | thinking 折叠显示，内容不重复出现（需去重合并） |
| STREAM-03 | 模拟 backend 信号丢失（断网超过 60s） | 60s 后 loading 自动消失（需 stall watchdog） |
| STREAM-04 | AI 执行长时间 Bash 命令（如 npm install） | 执行期间 loading 保持，不误触超时（需 heartbeat） |
| STREAM-05 | Streaming 快速连续多次 updateMessages | 消息顺序正确，不闪烁（需序列号过滤） |
| STREAM-06 | Codex 模式下工具调用 | 不出现重复的 tool_use 消息（需 stripDuplicate） |
| STREAM-07 | Codex 长对话被后端压缩 | 最新消息不消失（需 preserveOnShrink） |
| STREAM-08 | Stream 结束时 loading 消失 | 不被 stale rAF 重新设回 loading（需 cancelPending） |

---

### 模块 6：历史消息合并 🟡

| # | 测试用例 | 预期结果 |
|---|---|---|
| MSG-01 | 加载含多个连续纯文本 assistant 消息的历史 | 合并显示为一条 |
| MSG-02 | 相邻 assistant 消息，前为 tool_use，后为纯文本 | **不**合并（需 shouldMergeAssistantMessage） |
| MSG-03 | 相邻 assistant 消息属于不同 turnId | **不**合并（需 turnId 判断） |
| MSG-04 | 相邻 assistant 消息中间夹着 tool_result user 消息 | 跳过该 user 消息，继续合并 assistant（需 isToolResultOnlyUserMessage） |

---

### 模块 7：依赖管理 🟡

| # | 测试用例 | 预期结果 |
|---|---|---|
| DEP-01 | 打开设置 → 依赖管理 | 显示 claude-sdk / codex-sdk 安装状态 |
| DEP-02 | SDK 未安装，点击安装 | 触发安装，实时显示安装日志（需 installProgress） |
| DEP-03 | 安装完成 | 状态更新为已安装 + 版本号 |
| DEP-04 | 已安装，有更新版本 | 显示更新按钮 |
| DEP-05 | 版本下拉选择器 | 显示可用版本列表（需 versioning.ts + get_dependency_versions） |
| DEP-06 | 选择旧版本点击安装 | 触发回滚安装（需 getVersionAction） |
| DEP-07 | 卸载 SDK | 卸载成功，状态更新（需 uninstallResult 回调） |
| DEP-08 | Node.js 环境检测 | 检测结果实时回显（需 nodeEnvironmentStatus） |

---

### 模块 8：输入历史 🟡

| # | 测试用例 | 预期结果 |
|---|---|---|
| INPUT-01 | 发送多条消息后，在输入框按 ↑ 键 | 显示上一条发送内容 |
| INPUT-02 | 多次按 ↑ 键 | 继续回溯更早的历史 |
| INPUT-03 | 回溯后按 ↓ 键 | 向前回到更新的历史 |
| INPUT-04 | 设置 → 其他 → 输入历史 | 显示历史记录列表 |
| INPUT-05 | 删除单条历史记录 | 从列表移除 |
| INPUT-06 | 清空所有历史 | 列表清空 |

---

### 模块 9：Diff 主题 🟢

| # | 测试用例 | 预期结果 |
|---|---|---|
| DIFF-01 | 插件启动 | diff 区域 CSS 变量已初始化（需 applyDiffTheme） |
| DIFF-02 | VS Code 切换亮色主题 | diff 区域颜色跟随变化 |
| DIFF-03 | 在设置中手动切换 diff 主题为 soft-dark | 即时生效，刷新后持久化 |

---

### 模块 10：基础聊天功能 🟢

| # | 测试用例 | 预期结果 |
|---|---|---|
| CHAT-01 | 发送普通文字消息 | AI 正常回复 |
| CHAT-02 | 输入 `@` + 文件名自动补全 | 文件路径引用插入 |
| CHAT-03 | 选中代码后使用快捷键发送 | 代码片段作为附件附加 |
| CHAT-04 | 粘贴图片到输入框 | 图片显示为附件 |
| CHAT-05 | 切换 Provider（Claude ↔ Codex） | 后续消息走新 Provider |
| CHAT-06 | 切换 Model | 模型切换生效 |
| CHAT-07 | 点击停止生成 | 流式输出立即中断 |
| CHAT-08 | Tab A streaming 时切到 Tab B 发消息 | Tab B 独立处理，互不影响 |

---

### 模块 11：权限与 Plan 审批 🟢

| # | 测试用例 | 预期结果 |
|---|---|---|
| PERM-01 | AI 执行敏感 Bash 命令 | 弹出权限确认弹框 |
| PERM-02 | 选择"允许一次" | 本次执行，下次仍询问 |
| PERM-03 | 选择"总是允许" | 记住决定，不再弹框 |
| PERM-04 | 选择"拒绝" | 操作取消，AI 收到拒绝通知 |
| PERM-05 | Plan 模式下 AI 提出计划 | 显示 Plan 审批弹框 |
| PERM-06 | AI 通过 AskUserQuestion 提问 | 显示选项弹框，答案正确回传 |

---

### 模块 12：历史记录 🟢

| # | 测试用例 | 预期结果 |
|---|---|---|
| HIST-01 | 点击历史图标或输入 `/resume` | 打开历史记录视图 |
| HIST-02 | 历史列表显示 | 按时间倒序列出会话 |
| HIST-03 | 点击某条历史会话 | 加载该会话的消息内容 |
| HIST-04 | 删除历史记录 | 从列表移除，不可恢复 |
| HIST-05 | 收藏会话 | 标记收藏，可在收藏筛选中找到 |

---

### 模块 13：设置页面 🟢

| # | 测试用例 | 预期结果 |
|---|---|---|
| SET-01 | 添加 Claude Provider（填写 API Key） | 保存成功，可用于聊天 |
| SET-02 | 添加自定义 Model | 出现在 Model 选择列表 |
| SET-03 | 添加/编辑 Prompt | 可在 `/` 命令中使用 |
| SET-04 | 导出 Prompt 为 JSON | 文件下载成功，格式正确 |
| SET-05 | 从 JSON 导入 Prompt | 导入预览正确，确认后生效 |
| SET-06 | 添加/编辑 Agent | 可在 `@` 命令中选择 |
| SET-07 | 切换主题（亮/暗） | 界面颜色立即切换 |
| SET-08 | 修改发送快捷键（Enter ↔ Cmd+Enter） | 修改后新快捷键生效 |
| SET-09 | 开关 Streaming | 关闭后消息一次性显示 |
| SET-10 | 开关扩展思考（thinking） | 切换后 thinking 块出现/消失 |

---

## 八、迁移优先级总结

### 🔴 P0（核心功能不可用，必须先修复）

1. **bridge.ts 后端**：实现 `add/update/delete/toggle_mcp_server` 及 Codex 版本
2. **bridge.ts 后端**：实现 `get_mcp_server_tools`（MCP 工具列表）
3. **webview**：添加 `utils/todoShared.ts` + `utils/todoToolNormalization.ts`
4. **webview**：添加 `utils/turnScope.ts`（Todo/Subagent 状态最终化）
5. **webview**：修复 `App.tsx` 中 `/resume`、`/plan` 命令处理
6. **webview**：修复 `useSubagents.ts` 添加 `spawn_agent` 识别 + `normalizeToolInput`

### 🟡 P1（稳定性问题，影响日常使用）

7. **webview**：`streamingCallbacks.ts` 添加 stall watchdog（60s 超时自动恢复）
8. **webview**：`messageCallbacks.ts` 添加 RAF 缓冲 + 序列号过滤
9. **webview**：`messageSync.ts` 添加 Codex 去重 + 消息保护逻辑
10. **bridge.ts**：实现 `get_input_history` / `record_input_history` 等 4 个输入历史命令
11. **webview**：`DependencySection` 添加 `versioning.ts` 版本选择 UI
12. **bridge.ts**：实现 `get_dependency_versions`

### 🟢 P2（体验提升，可后续迭代）

13. **webview**：添加 `utils/diffTheme.ts` 并在 `App.tsx` 初始化
14. **webview**：`messageUtils.ts` 升级为智能 assistant 消息合并
15. **bridge.ts**：实现 `get_ide_theme` 同步 IDE 主题
16. **webview/bridge**：添加 `onStreamingHeartbeat` 防止工具执行期间误判超时
