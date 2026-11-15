# 安装

这个插件是一个 **DSH bundle**：一个 npm 包 + 一份 `cordis.patch.yml`。它由 DSH 的
插件管理器装进某个 profile，装完重启 DSH，就能在「设置 → 插件」里看到它。

> **先看清楚一件事**：本仓库只有源码，**没有 `lib/`**（`.gitignore` 排除了它）。
> `package.json` 的入口是 `lib/index.mjs`，所以无论用哪种方式安装，都**必须先构建一次**。
> 直接从 GitHub 装、或 `npm install` 源码，都会得到一个「声明了 bundle 但入口不存在」的包。

---

## 方式一：本地构建后按目录安装（推荐，当前仓库状态可用）

```bash
git clone https://github.com/ykallan/dsh-deveco.git
cd dsh-deveco
pnpm install
pnpm build          # 产物在 lib/：index.mjs + client/index.js
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

## 方式三：直接从 GitHub 安装（需要先加 `prepare`）

`plugin_manager` 的 `install_bundle` 接受 git 地址（装 GitHub 仓库前会先 `git ls-remote`
探一次连通性），但 pnpm 只会在安装时执行包自己的 `prepare` 脚本 —— 本仓库目前**没有**
这个脚本，所以直接 `github:` 安装会缺 `lib/`。要支持这条路径，给 `package.json` 加上：

```json
"scripts": {
  "prepare": "tsdown && node scripts/wrap-client.mjs"
}
```

再提交、推送。之后填 `github:ykallan/dsh-deveco` 即可。注意三点：

- 安装时会下载 devDependencies（`tsdown`、`lightningcss` 原生二进制等），比方式一慢；
- pnpm 可能要求批准这个构建脚本，插件页会给出「允许这些脚本并重试」；
- 这种安装会钉在一个提交上；升级需要换 spec（管理器只会对**完整 40 位提交**的 git 依赖
  提供更新通道）。

---

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

- **方式一（link 安装）**：`git pull && pnpm install && pnpm build`，然后重启 DSH。
- **方式二（npm）**：插件页对 registry 依赖提供版本列表与「更新」。
- **方式三（git）**：把 spec 换成新的完整提交并重装。

## 卸载

插件页里 **移除**（会同时清掉 `package.json` 依赖与 `dsh.profile.bundles` 里的条目）。
凭证与台账不会被删，位置见 README 的「数据落在哪」一节，需要的话手动删。

## 常见问题

| 现象 | 原因 |
|---|---|
| 插件页显示「未运行 / 无法加载」 | `lib/` 不存在或没构建完；先 `pnpm build` |
| 装完没反应 | 没重启 DSH（不开 HMR 时组合包只在启动时读取） |
| 添加时提示 `already-installed` | 这个包已经在 profile 依赖里，先移除再添加 |
| 添加时提示 `not-a-bundle` | 装的不是 bundle（缺 `dsh.bundle.patch`） |
| 登录后模型选择器里没有 DevEco | 卡片「体检」的 `provider` 项会指出 provider 是否注册成功 |
