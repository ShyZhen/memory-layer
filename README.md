# Memory Layer 插件

> https://github.com/ShyZhen/memory-layer

**面向 OpenClaw 的企业级多渠道多用户记忆分层插件。**


`memory-layer` 为 OpenClaw 提供多用户分层记忆能力，在保留共享知识的同时隔离每个用户的个人长期记忆。它把团队共享记忆与用户个人记忆拆开存储，避免不同用户之间的长期记忆互相污染，同时保留对旧版 `MEMORY.md` / `memory/*.md` 习惯的兼容。

默认情况下，它与渠道无关，基于 OpenClaw 的 session key 工作，适合钉钉、Telegram 以及其他支持独立 session key 的渠道场景。

英文版请见 [README-en.md](./README-en.md)。
维护设计说明请见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 发布 && 安装
### 发布
- ClawHub 发布前检查
```bash
clawhub package publish ShyZhen/memory-layer@main --family code-plugin --name @shyzhen/memory-layer --display-name "Memory Layer 记忆分层" --dry-run
```
- ClawHub 正式发布
```bash
clawhub package publish ShyZhen/memory-layer@main --family code-plugin --name @shyzhen/memory-layer --display-name "Memory Layer 记忆分层"
```
- npm 发布
```bash
cd memory-layer
npm pack
npm publish --access public
```

### 安装
- 安装方式1：直接从 ClawHub 安装：

```bash
openclaw plugins install @shyzhen/memory-layer
```
- 安装方式2：先从 npm 打包，再从本地 tarball 安装
> 原因：当前部分 OpenClaw / ClawHub 运行环境在安装 scoped 包 `@shyzhen/memory-layer` 时，可能会因为临时 zip 路径处理问题报 `ENOENT`。先 `npm pack` 再本地安装可以稳定绕过这个问题。

```bash
npm pack @shyzhen/memory-layer
openclaw plugins install ./shyzhen-memory-layer-0.7.0.tgz
```

## 核心能力

- 个人记忆按用户隔离，无需为每个终端用户单独创建 Agent 或 workspace
- 共享记忆与个人记忆分层存储，适合团队协作场景
- 兼容旧版 `MEMORY.md` 和 `memory/*.md` 使用习惯。如果已经存在污染，推荐手动拆分迁移、清洗。
- 保留 OpenClaw 原生“长期记忆 / 每日日记”语义，但把它改造成按用户隔离的多用户版本
- 支持多个 Agent 共用同一份共享记忆文件
- 新的个人记忆不再写回共享旧文件
- 支持通过 `enabledChannels` 限制生效渠道

## 适用场景

- 一个 Agent 同时服务多个钉钉用户
- 希望每个用户都有自己的长期记忆
- 希望团队共享知识可以跨用户、跨会话复用
- 不想继续把新的个人记忆写回旧版共享 `MEMORY.md`
- 需要逐步从旧 memory 习惯迁移到新的分层记忆模型

## 存储结构

默认目录结构如下：

- `shared/memory.md`：团队共享记忆
- `users/<channel>/<account>/<peer>/memory.md`：当前用户的长期记忆
- `users/<channel>/<account>/<peer>/notes/YYYY-MM-DD.md` 或 `YYYY-MM-DD-*.md`：当前用户的旧版日记重定向文件
- `users/<channel>/<account>/<peer>/history/YYYY-MM-DD.md`：当前用户的近期对话历史

默认这些文件位于 Agent workspace 下的 `.memory-layer/` 目录内。

## 工作方式

在每次 Agent 运行前，插件会按 `contextInjectionMode` 注入分层上下文：

- 共享记忆
- 当前用户的个人记忆
- 当前用户的兼容 `notes/`
- 当前用户的近期 `history/`（仅在注入策略允许时）

在每次 Agent 运行结束后，插件会自动：

- 把最近一轮真实用户消息和本轮助手回复追加到当前用户的 `history` 文件
- 在启用显式保存命令时，保存用户要求持久化的记忆

注意：

- 当 `contextInjectionMode = "new-session"` 时，共享记忆、个人记忆和兼容 `notes/` 会在新 session 首轮注入
- 此时 `history/` 只会在**自动归档后新开的 session** 中注入，不会在用户主动 `/new`、`/reset` 后带回，尊重用户的命令操作
- 插件不会把 `/new`、`/reset` 产生的 synthetic 会话启动提示归档进 `history/`
- 对于支持插件 `before_reset` hook 的较新 OpenClaw 版本，插件会优先根据结构化 `reason: "new" | "reset"` 识别手动 reset；对于较老版本，则继续使用 reset 启动提示与独立 `/new`、`/reset` 文本作为兜底兼容

对于插件接管的私聊会话，插件还会拦截并重写旧版 memory 文件读写，确保新的个人记忆不会再写进共享的旧版 `MEMORY.md` 中。
对于插件自己维护的 `shared/memory.md`、个人 `memory.md`、每日 `history`，还会按字符上限做软裁剪，避免文件无限增长。

可以把它理解为：插件没有推翻 OpenClaw 原生 memory 的基本分工，而是在多用户场景下做了一层“按用户隔离”的增强：

- 原来写 `MEMORY.md` / `memory.md` 的逻辑，会进入**当前用户个人长期 `memory.md`**
- 原来写 `memory/YYYY-MM-DD.md` 的逻辑，会进入**当前用户自己的 `notes/`**
- 这让原生“长期记忆 / 每日日记”的语义得以保留，但不再混写到所有用户共享的一套文件里
- 同时支持“显式保存命令”，见下文章节

## 推荐配置
**启用插件后，需要关闭 session-memory，防止openclaw继续写入默认记忆文件**
```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  },
  
  "plugins": {
    "allow": [
      "memory-layer"
    ],
    "entries": {
      "memory-layer": {
        "enabled": true,
        "config": {
          "baseDir": ".memory-layer",
          "recentHistoryDays": 2,
          "includeGroups": false,
          "allowInlineSaveCommands": true,
          "contextInjectionMode": "new-session"
        }
      }
    }
  }
}
```

## 配置项说明

- `baseDir`
  分层记忆的根目录。相对路径会相对于当前 Agent workspace 解析。默认值为 `.memory-layer`。
- `sharedFilePath`
  可选。指定共享记忆文件路径。
  不配置时默认使用 `<baseDir>/shared/memory.md`。
  如果多个 Agent 需要共用同一份团队记忆，可以把它们都指向同一个绝对路径。
- `recentHistoryDays`
  注入近期历史时，读取“最近有内容的 N 个日期文件”，而不是简单按自然日回看。默认值为 `2`。
- `contextInjectionMode`
  统一控制整个 `Layered Memory Context` 的注入策略，包括共享记忆、个人记忆、兼容 notes 以及近期 history。默认值为 `new-session`。
  可选值：
  - `always`：每轮都注入，兼容旧行为
  - `new-session`：(推荐设置)共享记忆、个人记忆和兼容 notes 会在新 session 首轮注入；`history/` 只会在自动归档后新开的 session 中注入，不会在用户主动 `/new`、`/reset` 后带回。如果当前 session 刚写入了共享/个人记忆，下一轮也会补注入一次。这是默认值，更适合一般聊天场景
  - `off`：关闭整个分层上下文注入
- `historyInjectionMode`
  已废弃的兼容别名。旧配置仍可继续使用，但新配置建议改用 `contextInjectionMode`。
- `includeGroups`
  是否让插件处理群聊、频道、主题等非私聊会话。默认值为 `false`。
- `enabledChannels`
  可选。限制插件只在指定渠道生效。
  如果不配置，则对所有支持的渠道生效。
- `autoCreateFiles`
  是否预创建默认的分层记忆文件与模板内容。默认启用。
  关闭后，插件不会主动生成默认 `shared/memory.md`、个人 `memory.md` 或 `meta.json` 模板，但在真实写入发生时，仍可能创建必要的父目录或目标文件。
- `allowInlineSaveCommands`
  是否启用显式保存命令。默认启用。
- `enabledAgents`
  可选。只对指定 Agent 生效。
  如果不配置，则对所有已加载该插件的 Agent 生效。
- `maxStoredSharedChars`
  共享记忆文件的存储软上限。默认值为 `20000`，`0` 表示不裁剪。
- `maxStoredPersonalChars`
  每个用户个人 `memory.md` 的存储软上限。默认值为 `20000`，`0` 表示不裁剪。
- `maxStoredHistoryChars`
  每个用户每日 `history/YYYY-MM-DD.md` 的存储软上限。默认值为 `30000`，`0` 表示不裁剪。

## 显式保存命令

如果用户消息中包含以下命令，插件会自动保存：

- `记住：...`
- `remember: ...`
- `共享记忆：...`
- `remember-shared: ...`

规则如下：

- `记住` / `remember` 写入当前用户自己的 `memory.md`
- `共享记忆` / `remember-shared` 写入共享记忆文件

这部分可以视为对 OpenClaw 原生 memory 行为的额外优化：

- 原生路径写入逻辑仍然会被兼容并重定向到分层目录
- 除了等待模型自己触发旧版 memory 写入，用户还可以通过 `记住：...` / `共享记忆：...` 直接、明确地把内容写入个人长期记忆或共享记忆
- 这让多用户企业场景下的“我现在就要记住这件事”变得更稳定、更可控

## notes 与 history 的实际作用

- `history/` 记录的是当前用户最近一轮原始入站消息与本轮助手回复，用来提供短期连续性上下文
- 当 `contextInjectionMode = "new-session"` 时，共享记忆、个人记忆和兼容 notes 会在新 session 首轮注入；`history/` 只会在自动归档后新开的 session 中注入，不会在用户主动 `/new`、`/reset` 后带回
- 在支持 `before_reset` 的新版本 OpenClaw 上，插件会直接根据 reset hook 事件判断“这是一次手动 `/new` / `/reset`”；在旧版本上，则回退到识别 OpenClaw 注入的 reset 启动提示或独立命令文本
- 如果当前 session 刚写入了共享/个人记忆，下一轮还会补注入一次，避免刚保存的记忆暂时不可见
- `notes/` 不是每次对话都会写入
- 只有当旧版工具去读写 `memory/YYYY-MM-DD.md` 或 `memory/YYYY-MM-DD-*.md` 时，插件才会把这些路径重定向到当前用户自己的 `notes/`
- 如果当前 Agent 完全不再使用旧版 `memory/*.md` 路径，那么 `notes/` 可能长期为空，或只留下少量历史兼容文件

## 支持的 Session Key

插件当前支持以下常见的 OpenClaw session key 形式：

- `agent:<agentId>:dm:<peerId>`
- `agent:<agentId>:<channel>:dm:<peerId>`
- `agent:<agentId>:<channel>:<accountId>:dm:<peerId>`
- `agent:<agentId>:<channel>:direct:<peerId>`
- `agent:<agentId>:<channel>:group:<id>`
- `agent:<agentId>:<channel>:channel:<id>`
- `agent:<agentId>:<channel>:group:<id>:topic:<topicId>`
- `...:thread:<threadId>`

重要限制：

- `session.dmScope = "main"` 可以运行，但会退化为**单用户模式**

原因是这种模式下所有私聊会共享同一个 session key，因此插件只能把所有私聊视为同一个“用户层”，无法实现按真实用户隔离的个人记忆。

## 多 Agent 共享记忆

如果你希望多个 Agent 共用同一份团队共享记忆，可以把它们的 `sharedFilePath` 都配置为同一个绝对路径。

示例：

```json
{
  "plugins": {
    "entries": {
      "memory-layer": {
        "enabled": true,
        "config": {
          "baseDir": ".memory-layer",
          "sharedFilePath": "C:\\Users\\zhenhuaixiu\\.openclaw\\memory\\team-shared.md",
          "recentHistoryDays": 2,
          "includeGroups": false
        }
      }
    }
  }
}
```

这表示：

- 每个 Agent 仍然保留各自 workspace 下的个人记忆层
- 所有启用该插件的 Agent 共同读写同一份共享团队记忆

## 限制到指定渠道

如果你只想让插件在特定渠道生效，可以配置 `enabledChannels`。

示例：

```json
{
  "plugins": {
    "entries": {
      "memory-layer": {
        "enabled": true,
        "config": {
          "enabledChannels": ["dingtalk", "telegram"],
          "baseDir": ".memory-layer"
        }
      }
    }
  }
}
```

如果省略 `enabledChannels`，则默认对所有支持渠道生效。

## 部署与兼容建议

- 强烈建议禁用内置的 `session-memory` hook，避免旧逻辑继续把个人记忆写回共享路径
- `2026.4.15` 这类旧版本可以继续使用本插件，本次更新不会要求它们必须增加新的 hook 白名单配置
- `2026.4.22` 及更早版本：不需要配置 `plugins.entries.memory-layer.hooks.allowConversationAccess`
- `2026.4.23`：这是过渡版本，运行时已经开始限制 conversation-access hooks，但配置校验对 `allowConversationAccess` 的支持还不完整；如果遇到相关 hook 被拦截，建议直接升级到 `2026.4.24+`
- `2026.4.24+`：建议为 `memory-layer` 显式配置：
  - `plugins.entries.memory-layer.hooks.allowPromptInjection = true`
  - `plugins.entries.memory-layer.hooks.allowConversationAccess = true`
- 旧版根目录 `MEMORY.md` 可以继续保留，作为兼容性的共享上下文
- 没有必要把 `sharedFilePath` 指向根目录 `MEMORY.md`
- 对于插件接管的私聊会话，优先使用 `layered_memory_search` 和 `layered_memory_get`
- 对于插件接管的私聊会话，不建议再依赖旧版 `memory_search` 和 `memory_get`
- OpenClaw 原生 memory 的自动 flush / 搜索索引针对的是根目录 `MEMORY.md` 和 `memory/*.md`，不会直接接管 `.memory-layer/**`
- 插件启动时会对 `session.dmScope = "main"` 和已启用的 `session-memory` 输出 warning，帮助排查“为什么没有按用户隔离”
- 对于 `2026.4.24+`，插件只会在检测到当前 OpenClaw 版本需要时，才提示 `allowConversationAccess` / `allowPromptInjection` 相关 warning，不会对旧版本误报

`2026.4.24+` 的附加 hooks 配置示例：

```json
{
  "plugins": {
    "entries": {
      "memory-layer": {
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        }
      }
    }
  }
}
```
- 如果你的 OpenClaw 版本已经支持 `before_reset` 插件 hook，推荐直接使用当前版本插件；它会优先走结构化 reset 识别。即使线上仍有旧版本节点，当前插件也保留了提示词兜底，不需要额外切换配置

## 说明

- 这是一个刻意保持文件化、可直接查看的实现，方便排查与迁移
- 近期历史是时效性上下文，不应视为唯一事实来源
- 如果你需要了解内部重写规则、兼容原因或维护排查细节，请查看 [ARCHITECTURE.md](./ARCHITECTURE.md)
