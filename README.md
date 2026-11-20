# @local/dsh-job-terminal — 后台任务终端

在 DSH Web GUI 的**左侧栏**新增「后台任务」页面：列出当前（或任选）会话的
`run_in_background` 任务，实时滚动显示所选任务的输出，并提供状态、耗时、进度、
两段式终止、复制输出、自动跟随/暂停跟随和跳到最新。

- 包名：`@local/dsh-job-terminal`
- 源码目录：`C:\Users\HiBer2007\dsh-plugins\dsh-job-terminal`
- 依赖：DSH 0.2.1（`@deepseek-ai/dsh-api-job-controller` 提供的 Client
  `jobs` 服务、`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-theme`）

## 使用

1. 刷新一次页面（Ctrl+R），让新安装的 Client 模块进入 boot 图。
2. 展开左侧栏，点击 **后台任务**（终端字形图标，位于「插件」与「自动化任务」之间）。
3. 页面顶部的「会话」下拉默认是当前会话；可以切换查看其他会话的任务（后台任务
   注册表按会话授权，切换会话不会激活或打断任何 Agent）。
4. 点击任务行查看实时输出；输出区底部可切换「跟随中 / 已暂停」，暂停后出现
   「跳到最新」。
5. 运行中的任务行右侧有停止按钮：第一次点击进入待确认（红色闪烁），3 秒内再次
   点击才会真正停止；列表底部会给出确认提示。停止失败会在同一位置显示。

页面顶部显示运行中/已结束数量；任务行显示状态点、标签、已运行时长、类型、状态以及
（有的话）进度行。输出区标题显示类型、状态、终止原因/退出码与进度，提供「复制输出」；
输出区底部显示当前视图已加载的字节数、跟随状态与「跳到最新」。字节数取自前端已
收到的观测文本（UTF-8 编码），而不是任务 ring 的过期投影，所以会随输出实时增长。

## 数据与「PTY」说明

`dsh-jobs` 的后台任务是**管道型 producer**：进程在启动时由 subprocess 服务分配
stdout/stderr 管道，输出进入每个任务自己的有界 ring；任务启动后不存在可以重新
打开的 OS PTY 句柄。因此不可能在事后把一个真实的 `node-pty` 终端「接」到正在运行
的后台任务上。

本插件连接的是**任务输出 ring 的实时字节流**：

- 数据来自 `@deepseek-ai/dsh-api-job-controller` 安装的 Client `ctx.jobs` 服务；
  它通过 `job.list` 跟随任务清单、通过 `job.follow` 从绝对偏移跟随单个任务的输出。
  这两个流都是**非消费式**的：不会移动模型 `job_output` 的游标，也不会吃掉模型
  的完成通知。
- 前端把同一份实时字节流按终端语义渲染：ANSI SGR（16 色 / 256 色 / 真彩色、
  加粗、斜体、下划线、反显、删除线）、`\r` 回车覆盖（进度条）、`\b` 退格、
  制表符、擦除行/屏与基础光标移动。字体大小和终端字体取自外观设置，颜色只使用
  宿主主题 token（ANSI 调色板是终端内容本身，固定为 xterm 默认的 Tango 色板）。
- 因此它给出的是与 PTY 终端一致的**实时屏幕行为**（颜色、回车覆盖、滚动跟随），
  只是复用任务 ring 作为数据源，而不是额外拉起一个 shell 去 `tail` 一个中转文件。
  这样没有第二份输出副本、没有额外进程、也没有 PTY 生命周期和终端数量配额问题。

如果你确实需要「在真实 PTY 里看任务」，正确做法是让任务在创建时就运行在 PTY 下
（例如给 `pwsh`/`bash` 工具增加一种 PTY 模式并把 PTY 屏幕通过 Remote 暴露给
侧栏）；这属于启动端改造，不是本插件能对既有任务事后完成的。

## 终止语义

停止按钮走的是 job controller 的**人类终止**路径（`ctx.jobs.kill`），Host 端以
`cancelled by the user` 作为原因并入任务的终止详情。它不冒充模型自己的
`job_kill`，所以拥有该任务的 Agent 仍会收到标准的完成通知；同时 shell 工具若仍在
等待该任务，会读到 `[stopped: cancelled by the user]`。两段式确认用于避免误触。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：空实现（面板是纯 Client UI，Host 资源由 job controller 提供） |
| `client.js` | 浏览器半边：侧栏图标、主面板、任务列表、ANSI 终端渲染、跟随/复制/终止、只读自检 provider |
| `cordis.patch.yml` | 插入 `job-terminal` 这一 Host row |
| `locale/zh.json`、`locale/en.json` | 插件管理器的标题与描述 |
| `icon.svg` | 侧栏/插件列表图标（原创，currentColor） |
| `test/job-terminal.test.mjs` | 纯逻辑单测 + apply 接线测试（假的 ModuleLoader/React/ctx） |

## 自检 Provider

Client 半边在成功注册两个 seat 之后，向 Client `cordisInspect` 注册一个**只读**
provider `JobTerminal`，方法 `status`（无输入）：

```json
{ "active": true, "panelId": "jobs", "currentSession": "…", "activePanel": null,
  "sidebarEntry": true, "mainPanel": true, "watchedSessions": 0, "localeNamespace": "jobTerminal" }
```

它只读地报告激活状态、当前会话、当前面板和已打开的 roster 流数量，不会修改运行时。
排查「图标没出现」时，用 `cordis_inspect_query` 查这个 provider 即可判断是 Client
半边没加载（provider 不存在）还是注册失败（字段为 false）。

## 验证

- `node --check client.js`、`node --check index.js` 通过。
- `node test/job-terminal.test.mjs` 通过：ANSI/CR/擦除/宽字符/截断、字节与时长
  格式化、任务排序、会话排序、两套字典 key 一致、apply 注册的 `main` / `sidebar.panellist`
  形状、主题 store、错误边界。
- 安装后的运行态检查（2026-11-20）：
  - `plugin_manager list_plugins` 显示 `include:job-terminal` 为 `enabled: true`、
    `fiberPhase: "active"` —— Host row 已在当前进程加载。
  - `/plugins/events` 的实时 graph 包含 `@local/dsh-job-terminal` 的 client 行
    （`immediately: true`、6 个 inject），combo URL 返回 200 且内容含本插件文案 ——
    Client 模块已进入 boot 图并由 Host 正常提供。
  - Client 只读 provider `JobTerminal` 在**未刷新页面**的热更新后即可查询：
    `sidebarEntry: true`、`mainPanel: true`、`activePanel: null`，证明 Client 半边
    已在当前页面激活并把两个 seat 注册进了 live slot registry。
  - 安装器返回的 `restart-required` 来自 HMR 对 profile 中既有待替换模块的保守
    判断；本插件的 Host row、Client 图行、两个 seat 均已生效。若侧栏图标尚未出现，
    刷新页面（Ctrl+R）即可让页面按新 boot 图启动；无需重启整个 DSH。
- 视觉确认边界：作者环境没有浏览器操控手段，无法目视断言图标/面板像素效果；
  首次使用请点击左侧栏「后台任务」确认。若图标未出现，打开浏览器控制台查看
  `client-modules:` 或 `slot entry crashed` 报错并反馈。

## 限制

- 任务输出 ring 是**有界**的：Host 侧默认运行中保留 256 KiB、结束后保留 16 KiB；
  Client 侧渲染尾部上限 128 KiB、DOM 最多渲染 2000 行（复制仍取当前保留的完整尾
  部文本）。更早的输出会以「较早的输出已滚出保留窗口」提示。任务 ring 的
  `output.total` 投影只在生命周期提交时刷新，所以页面不拿它当实时字节数。
- 任务记录和输出只存在于 Host 进程内；Host 重启后清空。
- 只读看输出，不向任务 stdin 写任何内容；需要交互式输入请用右侧栏的终端。
- 与本会话无关的会话也能被查看，这是 job controller 的会话授权模型（按传入的
  sessionId 做 owner fence），不是本插件额外扩大了权限。
