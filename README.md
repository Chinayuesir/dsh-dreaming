# 梦境 · DSH Dreaming

将 DeepSeek Harness 中已完成的会话整理成带出处、可编辑、可切换版本的本地记忆库。通过侧边栏管理记忆，在后续对话中按需查阅。

Dreaming turns completed DSH conversations into a local, versioned memory wiki. Browse and edit topics, inspect a memory map, select a configured model, and follow concise run logs from the sidebar.

## 功能

- **整理会话** — 会话菜单「⋯ → 梦境：整理此会话」，或按关键词选取会话；也可选择今天、本周、本月和自定义起止日期。
- **记忆地图** — 按分组查看主题，展开摘要、正文及可追溯的来源对话。
- **模型选择** — 沿用 DSH 的提供方与模型配置；默认跟随 DSH 默认模型，每次任务固定所选模型。
- **运行日志** — 查看阶段、等待模型的时间、格式纠正和失败原因；自动刷新、筛选、分页和复制。
- **版本与计划** — 编辑、回看和切换历史版本；可选每天定时整理。

## 安装与开始

这是 DSH 插件，需要已配置模型的 DeepSeek Harness。开发时使用的桌面版本为 **0.2.2-rc.1**；其他版本尚未完成兼容性验证。

从 [GitHub Releases](https://github.com/Chinayuesir/dsh-dreaming/releases) 获取 `dsh-dreaming.tgz`。当前预发布安装链接为 [v0.4.0 安装包](https://github.com/Chinayuesir/dsh-dreaming/releases/download/v0.4.0/dsh-dreaming.tgz)。在 DSH 的插件管理中添加该 Release 下载链接，按桌面端提示完成安装并重启，然后在侧边栏打开「梦境」。CLI 用户可用 `dsh plugin --profile <实际使用的配置名> add <Release下载链接>`；请确认安装到运行中的配置。

首次使用时，在 **配置与版本** 选好模型，再点 **选一条会话试跑**。看到「已发布新的记忆版本」后，在 **记忆库** 核对内容。若失败，打开 **运行日志** 查看具体阶段。

在新对话中可以这样说：

> 请先查梦境记忆，找出我们上次确认的启动命令与注意事项，列出用到的条目，再继续处理当前问题。

助手通过 `dreaming_memory` 先读取 `_index`，再打开相关主题。使用提示会加入上下文，实际读取由助手按任务需要决定；没有自定义 `@梦境` 入口，也没有每条消息必定检索的机制。

详见 [一页使用说明](使用说明.md)、[架构说明](ARCHITECTURE.md) 和 [更新记录](CHANGELOG.md)。

## 数据与运行方式

记忆默认保存在本机 `~/.dsh/dreaming-memory`。配置中可更换目录。完整的已完成会话会被送给你选定的模型提供方进行整理，可能包含工具输出。API Key 沿用 DSH 的配置，插件不另存一份。

```text
dreaming-memory/
  current.json
  versions/<版本>/
    _index.md
    notes/<主题>.md
    processed.json
    report.json
```

新结果先写入暂存区，通过检查后再发布。整理失败保留上一版本；批量任务允许部分会话成功后发布，并在报告中列出失败项。夜间计划默认关闭，需要 DSH 运行，关闭期间错过的计划在下次启动后补跑最近一次。

运行日志位于 DSH 状态目录的 `dreaming-logs.json`，通常是 `~/.dsh/dreaming-logs.json`。最多保留最近 20 次任务、每次 300 条诊断摘要；不主动保存对话正文、提示词或模型原始回复。报错只取首行、截断并过滤常见凭据，分享前仍应检查。

## 设计边界

参考 Anthropic 的 [Dreaming with a dynamic workflow](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)。本插件在 DSH 中实现会话导出、独立分析、全局整理和后续按需读取；由宿主固定编排，并非 Claude Managed Agents 的动态工作流实现。

当前主要追加、去重、合并与补链；尚未实现完整的过期事实替代、长主题自动拆分、失败任务断点续跑或分角色选模型。普通对话还可调用写入型 `dreaming_run`，因此也没有等同于只读挂载的权限隔离。每次最多 50 个会话、每批 2 个 Analyzer、每个角色最多 24 轮，整次任务限时 20 分钟。不读取附件二进制内容。

## 开发

代码无需构建。使用 Node.js 22 或更新版本运行 `npm test`，测试使用模拟会话和模型，无需 API Key；`npm pack` 生成可安装包。包名保留 `@local/dsh-dreaming`，通过 GitHub 分发，`private: true` 防止误发布到 npm。

MIT License。设计参考属于 Anthropic；本项目是独立的 DSH 插件。
