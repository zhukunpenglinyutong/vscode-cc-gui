# 自测检查清单

> 本次迁移涉及 16 个文件（7 个新增 + 9 个修改），以下用例覆盖所有迁移功能。
> 请逐项测试，在方框中标注结果：Pass / Fail / Skip

---

## 1. MCP 服务器管理（bridge.ts 后端新增）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 1.1 | 设置 → MCP → 点击"添加服务器"按钮，填写 name=`test-mcp`，command=`npx`，args=`-y @example/mcp-server` → 保存 | 列表中出现 `test-mcp` 服务器 | |
| 1.2 | 点击编辑 `test-mcp` 服务器，修改 command 为 `node` → 保存 | 配置更新成功，列表刷新 | |
| 1.3 | Toggle `test-mcp` 的启用/禁用开关 | 状态切换，出现 toast 提示 | |
| 1.4 | 点击删除 `test-mcp` 服务器 → 确认 | 服务器从列表移除 | |
| 1.5 | 展开某个 MCP 服务器卡片 | 显示工具列表面板（可能为空） | |
| 1.6 | 切换到 Codex 模式后重复 1.1-1.4 | Codex MCP 操作同样生效 | |
| 1.7 | 打开 `~/.claude/settings.json` 查看 | mcpServers 字段包含添加的服务器 | |

---

## 2. Slash 命令（useMessageSender + App.tsx）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 2.1 | 输入框输入 `/new` 回车 | 创建新会话，消息清空 | |
| 2.2 | 输入框输入 `/clear` 回车 | 清空当前消息 | |
| 2.3 | 输入框输入 `/resume` 回车 | 视图切换到历史记录列表 | |
| 2.4 | 输入框输入 `/continue` 回车 | 同 `/resume`，切换到历史视图 | |
| 2.5 | Claude 模式下输入 `/plan` 回车 | toast 提示 "Plan mode enabled"，模式切换为 plan | |
| 2.6 | Codex 模式下输入 `/plan` 回车 | toast 警告 "Plan mode is not available for Codex" | |
| 2.7 | Loading 状态下输入 `/resume` 回车 | 仍然跳转历史视图（不被 loading 阻挡） | |

---

## 3. Todo 任务面板（todoShared + todoToolNormalization + turnScope）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 3.1 | 让 AI 执行一个复杂任务，触发 `TodoWrite` 工具 | 右侧状态面板 Todo 区域显示任务列表 | |
| 3.2 | 让 AI 执行触发 `update_plan` 工具的任务 | Todo 面板同样显示计划列表 | |
| 3.3 | 观察 streaming 中的 Todo 项 | in_progress 状态项有正确的进行中样式 | |
| 3.4 | Streaming 结束后观察 Todo 面板 | 所有 in_progress 项自动变为 completed | |
| 3.5 | 在同一会话中发起新一轮对话 | Todo 面板只显示最新轮次的任务，旧任务消失 | |

---

## 4. Subagent 子代理面板（useSubagents + toolInputNormalization）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 4.1 | 让 AI 调用 `Task` 工具 | 状态面板子代理区域显示运行中的子代理 | |
| 4.2 | 子代理执行完成（有对应 tool_result） | 状态变为 completed（绿色） | |
| 4.3 | 子代理执行失败（tool_result 含 is_error） | 状态显示 error（红色） | |
| 4.4 | Streaming 结束后仍有 running 状态子代理 | 自动标记为 completed | |

---

## 5. Streaming 稳定性（streamingCallbacks + messageCallbacks + messageSync）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 5.1 | 发送一条消息，AI 正常流式回复 | 文字逐渐出现，界面不卡顿 | |
| 5.2 | 流式回复中包含 thinking（扩展思考） | thinking 块折叠显示，无重复内容 | |
| 5.3 | 快速连续发送多条消息 | 消息按正确顺序显示，不乱序 | |
| 5.4 | Streaming 正常结束 | loading 消失，消息完整显示 | |
| 5.5 | Codex 模式下发送消息并获得工具调用回复 | 不出现重复的 tool_use 消息 | |

---

## 6. Diff 主题（diffTheme.ts）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 6.1 | 启动插件，检查开发者工具 | document.documentElement 上有 `data-diff-theme` 属性和 `--diff-*` CSS 变量 | |
| 6.2 | VS Code 切换为亮色主题 | diff 区域颜色变化（如果 diff 主题设为 follow） | |

---

## 7. 消息合并（messageUtils.ts）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 7.1 | 加载含多个连续纯文本 assistant 消息的历史 | 合并显示为一条消息 | |
| 7.2 | 历史中有相邻 assistant，前为 tool_use 后为纯文本 | **不**合并，分开显示 | |
| 7.3 | 历史中有不同轮次（turnId）的相邻 assistant | **不**合并，分开显示 | |

---

## 8. 依赖版本管理（versioning.ts + DependencySection + bridge）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 8.1 | 设置 → 依赖管理 | 显示 claude-sdk / codex-sdk 安装状态 | |
| 8.2 | 等待版本列表加载 | 版本下拉选择器出现可选版本 | |
| 8.3 | 选择一个特定版本 | 下拉值更新，安装按钮可用 | |
| 8.4 | 点击安装/更新 | 安装流程启动，状态更新 | |

---

## 9. 基础聊天功能（回归测试）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 9.1 | 发送一条普通文字消息 | AI 正常回复 | |
| 9.2 | 输入 `@` + 文件名 | 文件引用自动补全出现 | |
| 9.3 | 选中编辑器代码 → Cmd+Shift+C | 代码片段附加到输入框 | |
| 9.4 | 切换 Provider（Claude ↔ Codex） | 后续消息走新 Provider | |
| 9.5 | 切换 Model | 模型切换生效 | |
| 9.6 | 点击停止生成按钮 | 流式输出立即中断 | |

---

## 10. 多 Tab 会话（回归测试）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 10.1 | 点击新建 Tab | 创建独立的空白会话 | |
| 10.2 | 在 Tab A 发消息，切到 Tab B | Tab B 消息区独立，不受影响 | |
| 10.3 | Tab A streaming 时切到 Tab B 发消息 | Tab B 可独立发送和接收 | |
| 10.4 | 关闭 Tab（保留至少 1 个） | Tab 被移除 | |

---

## 11. 权限弹框（回归测试）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 11.1 | 让 AI 执行需要权限的操作（如 Bash） | 弹出权限确认弹框 | |
| 11.2 | 选择"允许" | 操作继续执行 | |
| 11.3 | 选择"拒绝" | 操作取消 | |

---

## 12. 历史记录（回归测试）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 12.1 | 输入 `/resume` 打开历史视图 | 显示历史会话列表 | |
| 12.2 | 点击某条历史会话 | 加载该会话消息内容 | |
| 12.3 | 从历史返回聊天视图 | 聊天界面恢复正常 | |

---

## 13. 设置页面（回归测试）

| # | 操作步骤 | 预期结果 | 结果 |
|---|---|---|---|
| 13.1 | 添加 Claude Provider（API Key） | 保存成功 | |
| 13.2 | 添加 Prompt | 保存后可在 `/` 补全中看到 | |
| 13.3 | 添加 Agent | 保存后可在 `@` 补全中看到 | |
| 13.4 | 切换主题 | 界面颜色即时切换 | |
| 13.5 | 查看 Usage 统计 | Token 使用量正确显示 | |

---

## 测试环境要求

- VS Code 1.85+
- Node.js 18+
- 已安装 claude-sdk 或 codex-sdk

## 迁移文件清单

**新增文件（7个）：**
- `webview/src/utils/todoShared.ts`
- `webview/src/utils/todoToolNormalization.ts`
- `webview/src/utils/toolInputNormalization.ts`
- `webview/src/utils/turnScope.ts`
- `webview/src/utils/diffTheme.ts`
- `webview/src/hooks/windowCallbacks/parseSequence.ts`
- `webview/src/components/settings/DependencySection/versioning.ts`

**修改文件（9个）：**
- `webview/src/hooks/useSubagents.ts` — 添加 spawn_agent 识别 + normalizeToolInput
- `webview/src/hooks/useMessageSender.ts` — 添加 /resume, /plan 命令
- `webview/src/App.tsx` — diff 主题初始化 + Todo/Subagent 最终化 + 命令支持
- `webview/src/hooks/windowCallbacks/messageSync.ts` — Codex 消息去重 + 压缩保护
- `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts` — RAF 缓冲 + 序列号过滤
- `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts` — stall watchdog + heartbeat
- `webview/src/utils/messageUtils.ts` — 智能 assistant 消息合并
- `webview/src/components/settings/DependencySection/index.tsx` — 版本选择 UI
- `src/bridge.ts` — MCP CRUD + get_dependency_versions

**辅助修改（3个）：**
- `webview/src/utils/toolConstants.ts` — 添加 normalizeToolName 函数
- `webview/src/types/dependency.ts` — 添加 DependencyVersionInfo 类型
- `webview/src/global.d.ts` — 添加新 Window 属性声明
