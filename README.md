# 梦境 · DSH Dreaming

将 DeepSeek Harness 中已完成的会话整理成带出处、可编辑、可切换版本的本地记忆库。通过侧边栏管理记忆，在后续对话中按需查阅。

Dreaming turns completed DSH conversations into a local, versioned memory wiki. Browse and edit topics, inspect a memory map, select a configured model, and follow concise run logs from the sidebar.

## 功能

- **发布审核** — 所有整理先生成草稿，展示实际新增、修改、移除及模型提出的疑似冲突；确认后才进入对话可读的记忆。
- **项目范围** — 每个工作区独立存储；原有记忆保留在共享范围，不自动迁移。
- **新对话使用** — 自动提供当前项目与共享记忆的简短目录；可把主题设为默认，无需先有聊天历史。保留指定已有对话、读取记录与清除默认功能。
- **三个主栏目** — 记忆、整理、设置。地图和使用记录按需展开，审核与日志放在整理栏目中。

- **整理会话** — 会话菜单「⋯ → 梦境：整理此会话」，或按关键词选取会话；也可选择今天、本周、本月和自定义起止日期。
- **记忆地图** — 按分组查看主题，展开摘要、正文及可追溯的来源对话。
- **模型选择** — 沿用 DSH 的提供方与模型配置；默认跟随 DSH 默认模型，每次任务固定所选模型。
- **运行日志** — 查看阶段、等待模型的时间、格式纠正和失败原因；自动刷新、筛选、分页和复制。
- **版本与计划** — 编辑、回看和切换历史版本；可选每天定时整理。

当前版本：**0.5.2**。

## 安装与开始

这是 DSH 插件，需要已配置模型的 DeepSeek Harness。开发时使用的桌面版本为 **0.2.2-rc.1**；其他版本尚未完成兼容性验证。

从 [GitHub Releases](https://github.com/Chinayuesir/dsh-dreaming/releases) 获取 `dsh-dreaming.tgz`。当前安装链接为 [v0.5.2 安装包](https://github.com/Chinayuesir/dsh-dreaming/releases/download/v0.5.2/dsh-dreaming.tgz)。在 DSH 的插件管理中添加该 Release 下载链接，按桌面端提示完成安装并重启，然后在侧边栏打开「梦境」。CLI 用户可用 `dsh plugin --profile <实际使用的配置名> add <Release下载链接>`；请确认安装到运行中的配置。

首次使用时，在 **设置** 选好模型，再点 **选一条会话试跑**。整理完成后，在 **整理 → 审核草稿与发布变化** 核对草稿，逐项处理疑似冲突，点击 **确认以上变化并发布**。若失败，打开 **整理 → 运行日志与排错** 查看具体阶段。

在新对话中可以这样说：

> 请先查梦境记忆，找出我们上次确认的启动命令与注意事项，列出用到的条目，再继续处理当前问题。

对话中会出现 **上下文注入 · dreaming-memory**，点击可展开目录、范围、版本和查阅规则。当前项目与共享库各最多提供 1200 字符的目录，未审核草稿不进入目录。助手根据任务通过只读 `dreaming_memory` 读取完整 `_index` 和相关主题；共享库需显式指定 `scope: "shared"`。目录不表示事实已经被读取，具体读取可查看工具调用及插件中的读取记录。

主题旁的「设为默认参考」为新对话和未单独指定的已有对话提供优先查阅入口；「供选定对话查阅」仅用于指定对话。优先级为此对话指定 > 本项目默认 > 共享默认。引用保留选定时的版本，正文始终按需读取；旧版保存的节选不再自动注入。没有自定义 `@梦境` 入口，也没有每条消息必定检索、自动向量匹配或注入全库的机制。目录未变化且仍在上下文中时不重复插入；目录更新或上下文压缩后会重新提供。没有已发布记忆时，展开记录会明确说明。

这遵循 Cookbook 的“小型互链 wiki＋索引＋后续会话只读查阅”原则。在 DSH 中用只读工具替代 Managed Agents 的记忆存储挂载，目录快照是适配 DSH 的入口，原文并未要求每次发送消息自动匹配并注入事实。

详见 [一页使用说明](使用说明.md)、[架构说明](ARCHITECTURE.md) 和 [更新记录](CHANGELOG.md)。

## 数据与运行方式

记忆默认保存在本机 `~/.dsh/dreaming-memory`。配置中可更换目录。完整的已完成会话会被送给你选定的模型提供方进行整理，可能包含工具输出。API Key 沿用 DSH 的配置，插件不另存一份。

```text
dreaming-memory/
  pending.json                 # 待审核草稿指针
  drafts/<草稿>/                # 不对模型读取工具开放
  projects/<工作区路径哈希>/      # 独立项目库（相同版本与草稿结构）
  default-memory.json          # 项目/共享的默认主题引用
  session-memory.json          # 最多 100 个对话的指定主题引用
  memory-reads.json            # 最近 300 条读取/上下文记录，不含正文
  current.json
  versions/<版本>/
    _index.md
    notes/<主题>.md
    processed.json
    report.json
```

新结果先写入暂存区，通过检查后保存为待审核草稿，只有用户确认才发布。每个范围最多一份待审核草稿；草稿跨重启保留。审核期间已有记忆被编辑或切换到其他内容时，会拒绝过期草稿，需放弃并重新整理。整理失败保留上一版本；批量任务允许部分会话成功后提交审核，并在报告中列出失败项。夜间计划默认关闭，需要 DSH 运行，关闭期间错过的计划在下次启动后补跑最近一次。

运行日志位于 DSH 状态目录的 `dreaming-logs.json`，通常是 `~/.dsh/dreaming-logs.json`。最多保留最近 20 次任务、每次 300 条诊断摘要；不主动保存对话正文、提示词或模型原始回复。报错只取首行、截断并过滤常见凭据，分享前仍应检查。

## 设计边界

参考 Anthropic 的 [Dreaming with a dynamic workflow](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)。本插件在 DSH 中实现会话导出、独立分析、全局整理和后续按需读取；由宿主固定编排，并非 Claude Managed Agents 的动态工作流实现。

当前支持模型提出同主题事实冲突，并由用户选择替代旧事实、保留旧事实或双方待核实。旧事实以明确标记保留，不物理删除；冲突检测可能遗漏，不能视为完备的语义判断。尚未实现跨主题的自动事实生命周期、长主题自动拆分、失败任务断点续跑或分角色选模型。普通对话还可调用生成待审核草稿的 `dreaming_run`，因此也没有等同于只读挂载的权限隔离。每次最多 50 个会话、每批 2 个 Analyzer、每个角色最多 24 轮，整次任务限时 20 分钟。不读取附件二进制内容。

## 开发

代码无需构建。使用 Node.js 22 或更新版本运行 `npm test`，测试使用模拟会话和模型，无需 API Key；`npm pack` 生成可安装包。包名保留 `@local/dsh-dreaming`，通过 GitHub 分发，`private: true` 防止误发布到 npm。

MIT License。设计参考属于 Anthropic；本项目是独立的 DSH 插件。
