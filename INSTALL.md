# 安装

这个插件是一个 **DSH bundle**：一个 npm 包 + 一份 `cordis.patch.yml`。它由 DSH 的
插件管理器装进某个 profile，装完重启 DSH，就能在「设置 → 插件」里看到它。

> **构建产物 `lib/` 已在仓库内提交**（`index.mjs`、`client/index.js` 等），所以三种安装方式都**不需要**先构建。
> `package.json` 的入口是 `lib/index.mjs`；如果你改动了 `src/`，请用 `pnpm build` 重新生成 `lib/` 并一起提交。
> 对一个没有 `lib/` 的提交安装，会得到「声明了 bundle 但入口不存在」的包 ——
> 表现就是插件页里没有「账号管理」那张卡片。

---

## 方式一：按本地目录安装（推荐）

```bash
git clone https://github.com/ykallan/dsh-deveco.git
cd dsh-deveco
# lib/ 已提交，无需构建；只有改过 src/ 才需要：
# pnpm install && pnpm build
```

然后在 DSH 里安装这个**目录**：

- Web / Desktop 界面：侧边栏 **插件** 页 → **添加插件**，填入上面这个目录的
  **绝对路径**（例如 `E:\codes\project_about\codecli2apis\dsh-deveco`）。
  插件管理器接受绝对路径、npm 包名、`github:` 地址和压缩包；绝对路径会把依赖记成
  `link:<该目录>`，之后改代码只需要 `pnpm build` + 重启。
- 面向 agent 的 `plugin_manager` 工具：`install_bundle`，`target` 传同一个绝对路径。

装好后 **重启 DSH**（没开 HMR 时，运行中的组合不会变）。

## 方式二：从 npm 安装（发布之后）

```bash
npm publish          # 由包 owner 执行一次
```

之后在插件页搜 `dsh-deveco` 或直接填 `dsh-deveco`（可带版本，如 `dsh-deveco@0.1.0`）。
npm 包会带上 `lib/`，所以这条路径**不需要**你先构建。发布前请确认：

```bash
pnpm build
npm pack --dry-run   # 检查包里确实有 lib/index.mjs 和 lib/client/index.js
```

## 方式三：直接从 GitHub 安装

`plugin_manager` 的 `install_bundle` 接受 git 地址（装 GitHub 仓库前会先 `git ls-remote` 探一次连通性）。
仓库里已经带上了构建产物 `lib/`，所以直接填 `github:ykallan/dsh-deveco`
（或 `https://github.com/ykallan/dsh-deveco.git`）即可，安装时不需要任何构建步骤。

注意三点：

- 安装只会拉取当前提交（含 `lib/`）；如果你改过 `src/` 却没重新提交 `lib/`，装进去的就是旧产物；
- 这种安装会钉在一个提交上；升级需要换 spec（管理器只会对**完整 40 位提交**的 git 依赖提供更新通道）；
- 如果安装后仍看不到「账号管理」卡片，先确认该提交里确实有 `lib/client/index.js`，再重启 DSH。

## 本机开发：一条命令装进 profile

仓库自带的 `pnpm deploy` 走的是「profile 内副本 + `file:` 依赖」，重启后即可用：

```bash
pnpm install && pnpm build && pnpm deploy
```

```
<profile>/vendor/dsh-deveco/          产物副本（lib/ + 清单 + 文档）
<profile>/node_modules/dsh-deveco/    同一份副本（宿主立刻可解析）
<profile>/package.json                "dsh-deveco": "file:./vendor/dsh-deveco"
```

这和方式一（插件页按目录安装）的区别只在依赖怎么写：

| 依赖 | 插件文件在哪 | 风险 |
|---|---|---|
| `link:<checkout>`（插件页按目录安装） | 仓库里 | 仓库被 `git clean` / 误删 / 跟着 junction 递归删掉 → 下次启动 `cannot resolve profile bundle` |
| `file:./vendor/dsh-deveco`（`pnpm deploy`） | profile 内 | 仓库随便动都不影响；升级要重新 `pnpm build && pnpm deploy` |
| `0.1.0` 之类版本号 | profile 内 | 包没发布到 npm 时，插件页任何 pnpm 操作都会 `ERR_PNPM_FETCH_404` 并回滚 |

两种方式可以互换：先用插件页装过（`link:`），再跑一次 `pnpm deploy` 就会纠正成 `file:`。

## 装完怎么验证

1. **插件页** 出现 `DSH DevEco Connect`，且处于启用状态、没有报错。
2. **设置 → 插件 → DSH DevEco Connect** 能打开卡片（四个页签：账号 / 模型 / 额度 · 签到 / 显示）。
3. 卡片底部点 **体检**，`provider` 一项应为通过 —— 它表示 `deveco` 这个 provider
   真的注册到了宿主的模型层。失败通常意味着 `lib/` 是旧的，或者 DSH 没重启。
4. **登录** 一个华为账号后，对话窗口底部的模型选择器里应出现 `DevEco` 分组
   （`GLM-5.1-DevEco` / `GLM-5.3-DevEco` / 视觉模型）。

命令行也可以直接看状态（把端口换成你的 GUI 端口）：

```bash
curl http://127.0.0.1:58852/api/deveco/status
```

## 升级

- **方式一（link 安装）**：`git pull`（`lib/` 随仓库更新）；改过源码再 `pnpm build`，然后重启 DSH。
- **方式二（npm）**：插件页对 registry 依赖提供版本列表与「更新」。
- **方式三（git）**：把 spec 换成新的完整提交并重装。

## 卸载

插件页里 **移除**（会同时清掉 `package.json` 依赖与 `dsh.profile.bundles` 里的条目）。
凭证与台账不会被删，位置见 README 的「数据落在哪」一节，需要的话手动删。

## 常见问题

| 现象 | 原因 |
|---|---|
| 插件页显示「未运行 / 无法加载」 | `lib/` 不存在或没构建完；先 `pnpm build` |
| 插件页能打开，但没有「账号管理」卡片（一片空白） | 装的是没 `lib/` 的包（`lib/client/index.js` 不存在）：该提交没带构建产物，或 DSH 没重启。换带 `lib/` 的提交并重启，或本地 `pnpm build` 后按目录安装 |
| 装完没反应 | 没重启 DSH（不开 HMR 时组合包只在启动时读取） |
| 添加时提示 `already-installed` | 这个包已经在 profile 依赖里，先移除再添加 |
| 添加时提示 `not-a-bundle` | 装的不是 bundle（缺 `dsh.bundle.patch`） |
| 登录后模型选择器里没有 DevEco | 卡片「体检」的 `provider` 项会指出 provider 是否注册成功 |
