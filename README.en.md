# dsh-deveco

A DeepSeek Harness plugin that puts **Huawei DevEco Code (CodeGenie MaaS)** behind the
DSH model picker: sign in once with a Huawei account and use GLM-5.1 / GLM-5.3 / Qwen
vision models inside DSH — with multi-account rotation, a live model catalog, a daily
check-in and a local usage ledger.

> Unofficial. Not affiliated with Huawei or DeepSeek. It reuses the protocol DevEco
> Code's own client already speaks; upstream may change or tighten it at any time.

## Features

| Feature | What it does |
|---|---|
| **Huawei sign-in** | Browser authorization with a loopback callback (`127.0.0.1:10101 / 34567–34570`). No CLI, no API key. A pasted `jwtToken` also works. |
| **Multi-account** | One credential doc per profile, per-account refresh (single-flight + generation guard), pause / pin / rename / remove, automatic failover to another account on errors. |
| **Live model catalog** | Pulled from `codeGenie/modelConfig` at startup and hourly, merged across accounts; an allowlist narrows what the pickers offer. |
| **Thinking effort** | Per-model tiers (deepseek-v4.1-flash: Low/High/Max, glm-5.2: High/Max), default High, plus Off to really stop thinking. |
| **Daily check-in** | DevEco exposes no points or claim endpoint (see [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §6), so the check-in is a real daily probe: fetch each account's catalog, record the result, keep a streak, and mark a rejected credential for re-login. |
| **Local usage ledger** | Requests and tokens, aggregated by day / account / model. |
| **Request normalisation** | Role enum, `tool_choice` enum, output-cap clamp, effort snapping, explicit thinking request, vision rerouting. |
| **Queueing** | DevEco serves one generation per account; the plugin runs one in flight, queues at most three, then answers 429. |

## Install

```bash
pnpm install
pnpm build      # bundles land in lib/
pnpm deploy     # sync lib/ into ~/.dsh/profiles/desktop/node_modules/dsh-deveco
```

Restart DSH, then open **Settings → Plugins → DSH DevEco Connect** and sign in.

## Thinking effort

The picker offers thinking tiers **per model**, from that model's own capability:

| Model | Tiers | Default |
|---|---|---|
| `deepseek-v4.1-flash-1017` | Low / High / Max + Off | High |
| `glm-5.2` | High / Max + Off | High |

- **Only distinct tiers are listed.** Upstream accepts a longer enum but collapses it:
  deepseek maps `minimal→low`, `medium/high/xhigh→high`, `ultra/max→max`; glm-5.2 maps
  `low/medium→high`, `xhigh→max`. Listing the collapsed aliases would let a user switch
  tiers with no visible effect. Measurements: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §4.
- **Default is High** — sent explicitly instead of relying on the upstream default.
- **Off really disables thinking**: it sends `reasoning_effort: "none"`, which was measured
  to drive `reasoning_tokens` to zero. Off is only offered for models that accept it.
- **A thinking model with no tier list** (e.g. GLM-5.1, which only declares
  `thinking_mode: on`) shows no tier selector — upstream publishes no enum for it.

## Configure

| Key | Default | Meaning |
|---|---|---|
| `enabledModels` | `[]` | Model ids offered in the pickers (empty = all) |
| `showDock` | `true` | Status line under the chat input box |
| `showSidebarPanel` | `false` | Entry in the sidebar icon column |
| `showSettingsEntry` | `true` | Entry in the settings left navigation |
| `autoCheckin` | `false` | Run the daily check-in automatically |
| `maxConcurrent` / `maxQueue` | `1` / `3` | Upstream concurrency and local queue depth |

## Where data lives

- `~/.dsh/.deveco-accounts.json` — credentials (plaintext, `0600`)
- `~/.dsh/.deveco-checkin.json` — check-in ledger
- `~/.dsh/.deveco-usage.json` — local usage ledger
- `~/.dsh/.deveco-refresh.log` — why a refresh / sign-in / check-in failed
- `~/.config/deveco/country.region.xml` — region marker shared with DevEco Studio

Never commit `.deveco-accounts.json`.

## Architecture

```
DSH / pi-ai ──OpenAI──▶ loopback shim ──DevEco protocol──▶ cn.devecostudio.huawei.com
```

The shim owns account selection, credential resolution, request normalisation, header
injection, streaming/non-streaming path choice and the `exitSessionQueue` release. The
adapter only describes the models and points pi-ai at the shim.

Protocol details: [`docs/PROTOCOL.md`](docs/PROTOCOL.md). Development conventions:
[`AGENTS.md`](AGENTS.md).

## Disclaimer

For personal use and learning. Using it may violate the upstream's terms of service; the
account risk, quota changes and API breakage are yours to bear. Do not redistribute or
resell.
