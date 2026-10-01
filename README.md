# dsh-lark-link

独立的 DSH 飞书/Lark 桥接插件，包名 `@very12345/dsh-lark-link`。这是 [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link) 的个人分叉；上游作者为 amlyczz，本分叉由 Very12345 维护，许可证为 MIT。

兼容目标为官方 DSH 0.2 系列，开发和运行环境要求 Node.js >= 24。它可直接使用 DSH 的模型与会话，不要求 WebAgent 应用或网页模型后端运行。若要通过飞书使用网页模型，另装 `dsh-webagent-integration` 并连接其后端。

## 功能

- 飞书消息与 DSH 双向桥接，支持流式卡片和停止当前任务。
- 多应用、多用户的路由、会话、工作区与模型白名单隔离。
- 按钮式命令面板、会话切换、目录浏览、诊断与断连补偿。
- 凭据、入站 WAL、Outbox 和运行状态由插件管理；DSH 承担模型及 Agent 执行。

## 安装与启动

```sh
dsh plugin --profile desktop add github:Very12345/dsh-lark-link
# CLI WebUI 可选择 --profile web
```

也可在本仓库执行 `npm pack`，再通过 `dsh plugin --profile <name> add file:/absolute/path/package.tgz` 安装。Git URL 安装所需 `dist/` 已提交；修改 `src/` 后必须重新构建。加载新版本后重启对应 DSH 宿主/profile。

若安装器报告 `protobufjs` 构建脚本被阻止，按其提示使用 `dsh plugin --profile <name> approve-builds protobufjs` 允许该依赖。bundle patch 中的加载名必须是 `@very12345/dsh-lark-link`，避免与上游裸包名混用。

在 DSH 的输入框执行 `/lark setup` 完成应用配置，再执行 `/lark start`。Web UI 的 Lark 管理面板提供多应用及模型白名单设置。实际凭据写入 DSH 凭据服务，不放入 README 或源码。

## ⌨️ 命令

### DSH 侧（GUI 或终端）

```
/lark setup            扫码一键建应用（或 DSH_LARK_APP_ID/SECRET 手动通道）
/lark start|stop|restart|status   桥接生命周期与全链路健康
/lark uninstall-clean  清除凭据与状态目录
```

### 飞书侧（卡片化单选，无需记忆拼写）

| 类别 | 命令 | 行为 |
| ---- | ---- | ---- |
| 控制面板 | `/menu`（`/help` 内有入口） | **分组按钮面板**：一条命令一个按钮，点一下就执行，免记忆免输入 |
| 选择类 | `/mode` `/permission` `/model` `/reasoning` | **单选按钮卡片**，点选即切换（动态感知自建 preset、提供商与模型思考档位；`/thinking` 同义） |
| 目标类 | `/goal [目标\|pause\|resume\|clear]` | 目标控制台卡片：暂停 / 恢复 / 清除按钮 + 常用目标模板按钮 |
| 状态类 | `/status` `/usage` `/whoami` `/help` | 结构化健康卡（连接/队列/会话/补发分行，不再截断）/ 用量统计 / 当前会话诊断 / 分组命令清单 |
| 会话类 | `/new` `/resume [序号\|id]` `/sessions` `/stop` | 新会话（**确认卡片**防误触）/ 恢复历史会话 / 会话选择器（等价 `/resume`）/ 停止当前任务 |
| 工作区 | `/workspace` `/cwd` `/files [路径]` | **目录浏览器**：`..`、子文件夹、切换到此目录、新建文件夹、取消；单卡片原地流式刷新，可向上浏览到文件系统根 / 查看当前工作区及来源 / 列出目录内容 |
| 诊断 | `/doctor` `/reconnect` | ZIP 诊断包（session log + 配置 + ISSUE.md）/ 断连自救重连 |
| 热改 | `/lark-config` `/stream on\|off` | **按钮式设置面板**（流式卡片 / 表情回执 / 群策略一键切换）+ 高级文本形式；`/stream` 是流式开关快捷方式 |
| 桥管理 | `/lark [setup\|start\|stop\|restart\|status\|uninstall-clean]` | 无参时输出**按钮面板**，不必手打子命令 |
| DSH 命令 | `/compact` 等 | 原生执行，结果回飞书 |
| 多媒体 | 发图片/文件 | 图片→视觉模型；文件→文本提取 |
| 意图确认 | 模型提问 | 自动转**飞书意图确认卡片**，选项或输入作答 |

> 命令无拦截、无门禁：一切 `/` 消息要么桥处理，要么原样交 DSH——绝不静默丢弃。skill 无前缀，直接说任务即可。
>
> 每条命令回复都落在**自己的折叠面板**里：执行中蓝色计时、成功绿色、失败红色，后续交互在原地更新同一张卡片，不会刷屏。
> `/workspace` 浏览器允许向上浏览并切换到 dsh 工作区之上的目录（到文件系统根为止）；但模型侧的 `lark_send_local_file` 仍只允许发送**当前工作区内**的文件——这一不对称是刻意的：人能自由选目录，模型不能越权回传文件。

## ⚙️ 常用配置（`/lark-config` 热改，立即生效并持久化）

| 配置键 | 默认 | 说明 |
| ------ | ---- | ---- |
| `groupPolicy` | `open` | 群聊触发策略：`open`（免 @ 全触发）/ `mention` / `keywords` / `reply` |
| `groupKeywords` | `["lark","bot"]` | `keywords` 模式下的触发词 |
| `agentPreset` | `code` | Agent preset（shipped：standard/code/minimal/cordis，或 GUI 自建 id） |
| `permissionMode` | `danger-full-access` | 权限：read-only / workspace-write / danger-full-access |
| `streaming.enabled` | `true` | CardKit 流式卡片（默认开启；设为 `false` 可关闭） |
| `reactions.enabled` | `true` | 表情回执开关 |
| `reactions.receipt` / `done` / `error` | `OnIt` / `DONE` / `ERROR` | 三态表情（收到 / 完成 / 失败），需为飞书官方目录内的 emoji_type |
| `allowlist` | `[]` | open_id 白名单，空 = 所有人可对话 |
| `denyList` | `[]` | 命令前缀拒绝兜底 |
| `workspaceRoot` | `` | 桥会话工作区根目录（空 = process.cwd()） |
| `attachments.retentionHours` | `168` | 入站图片/文件的保留时长（小时，默认 7 天；`0` = 永久保留）。默认存系统临时目录，到期自动清扫 |
| `attachments.dir` | `` | 入站媒体根目录覆盖（空 = 系统 tmpdir；重启生效） |

> 凭据（appId/appSecret）存放在 DSH credentials 服务，不进普通配置文件。`/lark setup` 扫码和 Web UI 的 Lark 面板均写入同一安全凭据引用；状态接口只显示 App ID 掩码，不回显 App Secret。
>
> 手动更换 App ID 时，插件会先停止旧 WebSocket，再清空旧机器人的路由、去重、补发 WAL、发件箱和会话覆盖状态，防止旧机器人消息通过新机器人重放。
>
> 模型白名单是强制策略，不只是界面过滤：已有会话若引用刚被取消的模型，会立即回落到该应用的默认允许模型；飞书直接发送 `/model provider/model` 也无法越权。修改默认工作区后，没有单独 `/workspace` 覆盖的会话会在下一条消息新建于该工作区。
> 为确保运行中会话同步清退被撤销的模型，模型白名单只允许从 Web UI 的 Lark 管理面板修改，不开放 `/lark-config modelAccess=…` 旁路。

## 🩺 遇到问题？

1. 飞书发 `/doctor`，得到 ZIP 诊断包（完整 session log + 脱敏配置 + ISSUE.md 模板）
2. 把诊断包贴给任意 AI（或在 GitHub Issue 中发出来），即可快速定位
3. `/status` 可随时看连接 / Outbox / 补发 / 会话全链路健康

## 开发与分发

```sh
npm install
npm run check
npm test
npm run build
npm pack --dry-run
npm pack
```

`src/` 是 TypeScript 源码，`test/` 保存回归测试，`dist/` 是可分发宿主与客户端入口，`cordis.patch.yml` 是官方 bundle 配置。测试数量以当前测试报告为准。

每个仓库独立维护；本地私人部署记录在忽略的 `LOCAL-DEPLOYMENT.md` 和部署脚本中，不进入公共文档及发布包。工作区关系见 [总览](https://github.com/Very12345/dsagent-electron#readme)。

## 许可证与上游

MIT，见 [LICENSE](./LICENSE)。保留上游作者及许可证信息；本分叉发布内容、版本和安装名以当前 `package.json` 为准，不以旧上游 README 的徽章或 npm 版本推断。商标与关系说明见 [NOTICE](./NOTICE)。

## 设置页面

设置页与 Windows 电脑操作页使用一致的分区、开关、状态和主题样式，支持窄屏。凭据和模型访问策略保留明确的保存操作。
