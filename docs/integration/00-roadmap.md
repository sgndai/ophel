# Lightweight Chat UX Layer Roadmap

本分支目标是把 Ophel 作为主容器，逐步吸收 Timeline、My Prompt、GPT-Conversation-Toolkit、AI Chat Exporter、Loominary 中对日常网页端 AI 对话有价值的能力。第一阶段只关注 ChatGPT、Gemini、DeepSeek。

## 第一版范围

第一版先做 4 件事：

1. 轻量消息导航：右侧节点轴同时覆盖用户消息与 AI 回复，支持非输入状态下用上下方向键跳转。
2. QuickButtons 减负：后续把默认常驻按钮压缩成更少入口。
3. 提示词队列小型化：后续把 QueueOverlay 默认入口改成输入框附近小胶囊。
4. 性能基线：避免重复 DOM 扫描，隐藏时停止无意义监听。

## 当前提交

当前提交先落地第一项的 MVP：新增 `MessageNavigatorManager`，作为独立轻量层挂载在页面右侧。它不改动 Ophel 主面板、不占用 OutlineTab，也不复用大纲树。

## 第一版验收标准

- ChatGPT、Gemini、DeepSeek 页面上出现右侧轻量节点轴。
- 节点包含用户消息和 AI 回复，使用 `U/A` 区分。
- 鼠标悬停能看到消息摘要。
- 非输入状态下，`ArrowUp` / `ArrowDown` 跳转上一条 / 下一条消息。
- 输入框、textarea、select、contenteditable、iframe 聚焦时不拦截上下键。
- 节点变化通过节流刷新，滚动高亮通过 `requestAnimationFrame` 合并更新。

## 暂缓内容

- NotebookLM 引用导出修复暂缓。
- My Prompt 的历史导航 bug 暂缓，等单独读源码。
- ChatGPT API 会话索引暂缓，先跑 DOM 版 MVP，再比较 GPT-Conversation-Toolkit 的虚拟化方案。
- QuickButtons 和 QueueOverlay 的 UI 改造放到第二批提交。
