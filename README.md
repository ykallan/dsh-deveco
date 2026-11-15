# dsh-deveco

把**华为 DevEco Code（CodeGenie MaaS）**接入 DeepSeek Harness 的插件。

登录一次华为账号，就能在 DSH 的对话窗口里用 DevEco 的模型（GLM-5.1 / GLM-5.3 / Qwen 视觉），
支持**多账号轮转**、**动态模型目录**、**每日签到**、**本机用量账本**，并能在设置里管理一切。

> 这不是官方插件，也不是华为的产品。它只是把 DevEco Code 命令行客户端已经在用的接口，
> 接到 DSH 的模型层上。上游随时可能改接口或收紧额度，届时插件会跟着失效。

---

## 功能

| 功能 | 说明 |
|---|---|
| **华为账号登录** | 浏览器授权 + 本机回环回调（`127.0.0.1:10101 / 34567–34570`），不需要命令行工具、不需要填 API Key |
| **多账号管理** | 每个账号独立凭证与续期；卡片上可暂停、置顶、改备注、刷新凭证、删除；请求失败自动换号重试 |
| **动态模型目录** | 启动时与每小时从上游 `codeGenie/modelConfig` 拉一次，按账号取并集；可勾选只暴露部分模型 |
| **每日签到** | 每天每个账号做一次真实体检（凭证是否还有效、模型目录是否还能拉到），记录结果与连续天数 |
| **额度窗口** | 按上游的重置时刻（默认每日 08:00）划分窗口，显示重置倒计时、本窗口本机用量、以及被上游判「额度用尽」的账号；「刷新额度」重新探测账号可用性 |
| **本机用量账本** | 记录经本插件发出的请求数与 token 用量（按天/账号/模型聚合），卡片与底部状态行都能看 |
| **请求体适配** | 按上游六条硬规则重写请求（角色枚举、`tool_choice` 枚举、输出上限、思考档位、思考索要、视觉改路由） |
| **并发与排队** | 上游每个账号只放一个生成；插件自身 1 并发 + 最多 3 个排队，超出直接 429，不假装还在跑 |

## 安装

插件是一个 DSH bundle。**注意：仓库里没有 `lib/`（构建产物不入库），任何安装方式都要先构建。**
三种安装方式（本地目录 / npm / git）的完整步骤见 [INSTALL.md](INSTALL.md)。

最短路径：先构建，再在 DSH 的**插件页 → 添加插件**里填这个目录的绝对路径。

```bash
git clone https://github.com/ykallan/dsh-deveco.git
cd dsh-deveco
pnpm install
pnpm build          # 产物在 lib/：index.mjs + client/index.js
```

装好后重启 DSH，在 **设置 → 插件 → DSH DevEco Connect** 里登录。

<details>
<summary>开发者：一条命令装进本机 profile</summary>

```bash
pnpm build && pnpm deploy
```

`pnpm deploy` 会把构建产物装成 **profile 内自足的一份副本**，并把依赖记成
`file:./vendor/dsh-deveco`：

```
<profile>/vendor/dsh-deveco/          产物副本（lib/ + 清单 + 文档）
<profile>/node_modules/dsh-deveco/    同一份副本
<profile>/package.json                "dsh-deveco": "file:./vendor/dsh-deveco"
```

这样做的原因（两种更直觉的做法都踩过坑）：`link:<checkout>` 会把插件文件留在仓库里，
仓库一被清理就在下次启动报 `cannot resolve profile bundle`；写版本号则因为包还没发布到
npm 而换来一次 `ERR_PNPM_FETCH_404` 并回滚安装。脚本幂等，重跑只覆盖有变化的文件，
不会动 profile 的默认模型，也不会碰 `cordis.patch.yml` 里别的条目。
</details>

## 使用

1. **登录**：点「登录华为账号」，浏览器会打开华为登录页；授权完成后自动回到卡片。
   只支持中国大陆站点（`siteId=1`）与中国大陆账号。
2. **选模型**：在对话窗口底部的模型选择器里选 `DevEco` 下的模型。
   `GLM-5.1-DevEco` / `GLM-5.3-DevEco` 是华为部署版（和智谱公版同名不同源，所以加了后缀）。
3. **多账号**：重复登录即可。卡片上可以给账号改备注、置顶（优先用）、暂停（不参与轮转）。
   某个号的凭证失效时会自动标成「需重新登录」，不影响其它号。
4. **签到**：点「立即签到」。所有账号逐个体检，失败原因会留在卡片上。

## 额度：没有「剩余额度」可以查

DevEco **没有额度查询接口** —— 它一共只暴露登录、`codeGenie/modelConfig`、聊天、
`exitSessionQueue` 这几个端点，没有一个会告诉你「还剩多少」（见
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) §6）。所以插件里**不会有**「刷新余额」这种按钮，
也不会编一个剩余数字出来。

能确认的是：免费额度每天在固定整点清零（实测为本地 **08:00**，可用
`DEVECO_QUOTA_RESET_HOUR` 覆盖）。插件因此按这个时刻划分「额度窗口」，在卡片上给你：

- **窗口与倒计时**：`11-15 08:00 → 11-16 08:00`，还剩多久重置；
- **本窗口本机用量**：经本插件发出的 token 数（不含其它设备/IDE，所以不等于账号总额度）；
- **额度用尽标记**：上游真的拒绝时（`403 UserRateLimit` / `FreeUsageLimitError` /
  限流 429）把那个账号标成「额度用尽」，窗口一换自动作废。服务过载
  （`ModelServiceError` / `Full inference timed out`）不算额度用尽，不会误标。

「刷新额度」按钮**不会让额度变多**。它做的是：对每个账号发一次轻量但需要鉴权的请求
（拉模型目录），确认「这个号现在还能不能用」，并把结果写回上面的状态。额度到底有没有
重置，只有时间和下一次请求能证明。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabledModels` | `[]` | 模型选择器里允许出现的模型 id；空 = 全部 |
| `showDock` | `true` | 对话输入框下方那行 DevEco 状态 |
| `showSidebarPanel` | `false` | 侧边栏图标列里的入口（图标列是共用资源，缺省不占） |
| `showSettingsEntry` | `true` | 设置左侧导航里的入口 |
| `autoCheckin` | `false` | 每天自动签到（启动 30 秒后一次，之后每 6 小时检查，一天只签一次） |
| `maxConcurrent` | `1` | 同时打到上游的生成数（上游每账号只放 1 个） |
| `maxQueue` | `3` | 本地排队上限，超出直接 429 |

环境变量：`DEVECO_VISION_MODEL`（视觉模型 id）、`DEVECO_TOOL_IMPROVEMENT=1`（上报开关）、
`DEVECO_MAX_CONCURRENCY` / `DEVECO_MAX_QUEUE` / `DEVECO_QUEUE_COOLDOWN_MS`、
`UPSTREAM_IDLE_TIMEOUT_MS`、`DEVECO_MAX_OUTPUT_TOKENS`（单次输出上限，默认 32000）、
`DEVECO_REFRESH_SKEW_MINUTES`（令牌提前续期阈值，默认 **10** 分钟）、
`DEVECO_QUOTA_RESET_HOUR`、`DSH_HOME`（插件数据目录，默认 `~/.dsh`）。

### 令牌续期策略

`accessToken` 只有 30 分钟。插件**在每次取号发请求前**检查剩余寿命：

- 剩余 **≥ 10 分钟** → 直接用；
- 剩余 **< 10 分钟**（含没有到期时间、已过期）→ **先静默刷新，再发请求**，不会拖到过期后
  才报 401；
- 刷新被上游明确拒绝（JWT 过期 / 401）→ **等 5 秒 → 刷新令牌 → 重试同一个号，最多 5 次**；
  5 次仍失败才判定该号需要重新登录，并停止这次推理；
- 刷新因网络抖动失败 → 只冷却 30 秒，**不判死账号**；旧令牌若还没真过期就先用它。

为什么 401 要「等 5 秒再刷新」：令牌服务有短暂传播延迟，401 之后立刻刷新经常拿到的还是
旧状态，5 秒能让新令牌真正生效。为什么是「重试」而不是直接判死：`accessToken` 只有 30 分钟，
一次「推理 → 工具 → 再推理」的长回合里中途过期很常见，续期后就能接着跑完。

后台每 5 分钟还会扫一遍所有账号，把快过期的提前续掉（**正在被请求使用的账号会跳过** ——
换新令牌会让在飞的流当场被判「密钥无效」）。阈值可用 `DEVECO_REFRESH_SKEW_MINUTES` 调整。

## 数据落在哪

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/.deveco-accounts.json` | 多账号凭证（含 `jwtToken`） | `0600` |
| `~/.dsh/.deveco-checkin.json` | 签到台账（按天/账号） | 默认 |
| `~/.dsh/.deveco-usage.json` | 本机用量账本 | 默认 |
| `~/.dsh/.deveco-refresh.log` | 续期/登录/签到失败的原因（1MB 截断） | `0600` |
| `~/.config/deveco/country.region.xml` | 国家/区域标记（与 DevEco Studio 共用格式） | `0644` |

凭证是**明文**存的（`0600`）。这是纯客户端方案：不存就得多开一次浏览器登录。
不要把 `.deveco-accounts.json` 提交到任何仓库。

## 排障

- **卡片一直「读取中」** → 宿主 WebServer 没起来，或 `/api/deveco/status` 被拦截。
  卡片只接受 loopback 请求（`Host` 与 `Origin` 都必须是回环）。
- **登录页打开了但卡片一直等** → 回调端口被占用。看 `~/.dsh/.deveco-refresh.log`，
  里面会写 `login failed (...)`。也可以用「粘贴 jwtToken」这条路绕过浏览器。
- **模型目录是空的** → 上游没返回模型，或还没登录。点「刷新模型」看返回的账号级错误。
- **对话报 401** → 该账号需要重新登录；卡片上会显示「需重新登录」。其它号不受影响。
- **对话报 `context`** → 撞到渠道上限（GLM 系 170K 上下文 / 32K 输出）。插件会把
  请求里的输出上限钳到 32K，但上下文要靠会话压缩。
- **回答中途提示「已达到输出 token 上限」** → 这是**输出上限**（`max_tokens`），不是上下文
  窗口；两者独立，1M 上下文也照样只能一次输出 32K。推理内容与正文**共享**这个额度，所以
  长推理会在中途撞线。插件按渠道上限 32K 发请求（可用 `DEVECO_MAX_OUTPUT_TOKENS` 覆盖，
  不能调大过渠道）。若仍不够用，就分段发「继续」。点开「体检」能看到 `output-ceiling`
  一节，直接显示最近一次请求实际发出去的 `max_tokens`。
- **模型选择器里没有 DevEco** → 卡片底部的「体检」会指出具体是哪一关没过。其中
  `provider` 那一条说明 provider 有没有真的注册到宿主的模型层：为 false 时通常是
  `lib/` 还是旧的（没重新 `pnpm build`），或者 DSH 没重启。

## 原理

```
DSH / pi-ai ──OpenAI──▶ 本机回环 shim ──DevEco 协议──▶ cn.devecostudio.huawei.com
                              │
                              ├─ 选号（账号池）→ 解析凭证（必要时静默续期）
                              ├─ 请求体适配（normalize.ts）
                              ├─ 注入 Session-Id / Chat-Id / x-deveco-task 等头
                              ├─ 流式 / 非流式走两条不同路径
                              └─ 结束后 POST exitSessionQueue 释放服务端排队槽位
```

上游的接口细节（端点、必需请求头、六条请求体规则、错误语义）都记在
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)。改转发逻辑前请先读那一份。

## 开发

```bash
pnpm typecheck   # 宿主侧 + 浏览器侧两套 tsconfig
pnpm test        # vitest（纯函数为主，不打真实上游）
pnpm build       # tsdown + wrap-client（CSS module 会生成 .d.ts）
```

约定见 [`AGENTS.md`](AGENTS.md)。

## 免责声明

本插件与华为、DeepSeek 均无隶属关系，供个人学习与自用。使用它可能违反上游的服务条款；
账号风险、额度变化、接口失效都由使用者自行承担。请勿用于商业分发或转售。
