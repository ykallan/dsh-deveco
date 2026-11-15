# dsh-deveco 开发约定

面向在本仓库里改代码的 agent / 人。用户文档见 `README.md`，上游协议事实见
`docs/PROTOCOL.md`。

## 常用命令

```bash
pnpm typecheck     # 宿主侧 tsc + 浏览器侧 tsc（两套 tsconfig，别只跑一个）
pnpm test          # vitest，纯函数为主，不打真实上游
pnpm build         # tsdown（宿主 ESM + 客户端 CJS），再 wrap-client 包成自注册 bundle
pnpm deploy        # 把 lib/ 装进 profile 的 vendor/ 与 node_modules/（依赖记成 file:）
node scripts/smoke-apply.mjs   # 离线跑一遍 apply()：路由 / provider 注册 / 门禁，不打上游
```

本机安装方式（`pnpm deploy` 做的事）：

```
<profile>/vendor/dsh-deveco/          构建产物副本（lib/ + 清单 + 文档）
<profile>/node_modules/dsh-deveco/    同一份副本（宿主立刻可解析）
<profile>/package.json                "dsh-deveco": "file:./vendor/dsh-deveco"
```

为什么不是 `link:` 也不是版本号（两种都踩过）：

| 做法 | 后果 |
|---|---|
| `link:<checkout 路径>`（插件管理器按目录安装会这么写） | 插件文件留在 checkout 里；checkout 被清理 / 误删 / 跟在 junction 后递归删除，下次启动就是 `cannot resolve profile bundle "dsh-deveco"` |
| `"0.1.0"` 之类版本号（包没发布到 npm） | 插件页安装会 `ERR_PNPM_FETCH_404` 并回滚 |
| **`file:./vendor/<pkg>` + profile 内副本** | 文件自足、无需 registry；`pnpm deploy` 幂等重装 |

Windows 上**永远不要**用 `Remove-Item -Recurse` 删 junction/符号链接：它会跟进目标把内容一起删掉
（脚本里的 `unlinkIfLinked()` 用 `rmdirSync` 只删链接本身）。

**改了宿主侧代码必须重启 DSH 才生效。** 客户端产物由 `dsh-client-hmr` 自动送进浏览器，
宿主模块不会热载；部署脚本只覆盖内容不同的文件，所以「重启后行为没变」通常是没重新 build。

本机没有全局 `pnpm` 时，用宿主自带的 node + pnpm：

```bash
node "$env:LOCALAPPDATA/../../.dsh/dsh-runtimes/.../pnpm/bin/pnpm.mjs" install
```

## 分层：谁负责什么

```
src/config.ts      上游常量（端点/头/上限）—— 唯一的字面量出处
src/auth.ts        凭证与多账号文档；单账号续期（单飞 + 代际 + 冷却）
src/login.ts       浏览器授权 + 回环回调（一次性，只绑 127.0.0.1）
src/catalog.ts     模型目录的数据结构、合并、勾选过滤、参数兜底
src/discovery.ts   codeGenie/modelConfig 的抓取与解析
src/account-pool.ts 谁现在能接活（槽位/冷却/暂停/置顶）
src/queue.ts       全局并发闸门（1 在飞 + 最多 3 排队 + 入场冷却）
src/normalize.ts   请求体适配（六条硬规则，全是纯函数）
src/upstream.ts    请求头 / 路径 / exitSessionQueue / 错误归类 / 用量抽取
src/shim.ts        回环 HTTP 服务：选号、换号重试、流式透传、记账
src/adapter.ts     pi-ai provider（模型描述 + 指向 shim）
src/usage.ts       本机用量账本（按额度窗口分桶）
src/quota.ts       额度窗口（08:00 重置）+ 额度用尽标记；上游没有余额接口，别造假数字
src/checkin.ts     签到台账 + 每账号每日体检
src/web-status.ts  同源路由（只服务 loopback，不吐令牌）
src/index.ts       组装：Config、定时器、provider 注册、路由挂载
src/client/*       浏览器侧：卡片、底部状态行、侧边栏页
```

## 硬约定

- **纯 ESM + 源码里相对导入带 `.ts` 后缀**（`import { x } from './config.ts'`）。tsdown 负责打包。
- **客户端不能 import 宿主模块的运行时值**。类型可以（`import type`），纯常量请自己抄一份
  —— 一旦运行时 import 到 `web-status.ts`，`node:http` / `pi-ai` 就会被拖进浏览器包。
- **每个 `(kind, path)` 只能 `ctx.webServer.register` 一次**。同一路径的 POST 和 DELETE
  必须共用一个 handler，否则第二次注册会抛 duplicate route，把同一次 effect 后面的注册全跳过。
- **所有路由都要过 loopback 检查**（`hostIsLoopback` + `originIsLoopback`），写操作还要
  `content-type: application/json`。
- **令牌不进浏览器**：状态文档里只允许账号名、时间戳、状态。
- **新增 CSS 类名先 `pnpm build`（生成 `.module.css.d.ts`）再 typecheck**。
- **模型描述里的 `maxTokens` 是「单次输出上限」，不是上下文窗口**。pi-ai 在请求没带
  `max_tokens` 时直接拿它当天花板，而推理与正文共享这个额度 —— 给它一个保守小值（曾经是
  8192）会让 1M 上下文的模型在推理中途被截断。上游没给 `output` 时用
  `DEVECO_OUTPUT_CEILING`（32K），不要退回小数字。
- **签到不要变成「领积分」**：上游没有这个接口（`docs/PROTOCOL.md` 第 6 节）。它是每日体检。
- 续期必须单飞并带代际：`refreshToken` 一次性，并发刷新会把账号写成 stale。
- 每轮结束必须在 `finally` 里 `exitSessionQueue`，否则服务端排队名额会一直漏。

## 测试口味

- 只测纯函数与本地状态机；需要网络的测试用 `globalThis.fetch` 打桩，并在 `finally` 里还原。
- 每个 spec 自己建临时目录（`mkdtempSync`），`afterEach` 删掉，不碰用户真实数据。

## 发布

用户没明确说「推 github / 发版」时，只到 `typecheck` → `test` → `build` → `deploy` 为止。
不要自行 `git push`、打 tag、建 Release 或 `npm publish`。
