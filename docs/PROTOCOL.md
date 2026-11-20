# DevEco protocol notes

What this plugin relies on, and where each fact came from. Everything here was read from
two working implementations (`opencode-deveco`, and `deveco-code`'s `packages/opencode`
plugin) and cross-checked against the live behaviour recorded in those repos.

Keep this file in sync with `src/config.ts`: that module is the single source of the
literals, this file explains *why* they are what they are.

---

## 1. Endpoints

| Purpose | Method | URL |
|---|---|---|
| Sign-in page (browser) | GET | `https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=<port>&appid=1008&code=<32hex>` |
| `tempToken` → `jwtToken` | GET | `https://cn.devecostudio.huawei.com/authrouter/auth/api/temptoken/check?tempToken=…&site=CN&version=1.0.0&appid=1008` |
| Validate `jwtToken` / refresh / issue `accessToken` | GET | `https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check` (headers `refresh`, `jwtToken`) |
| Model catalog | GET | `https://cn.devecostudio.huawei.com/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.<version>` |
| Chat, streaming | POST | `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions` |
| Chat, non-streaming | POST | `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/no-stream/chat/completions` |
| Release the server queue slot | POST | `https://cn.devecostudio.huawei.com/sse/codeGenie/exitSessionQueue?modelId=<id>` |
| Sign-in success/failure landing pages | GET | `…/console/DevEcoCode/loginSuccess` · `…/loginFailed` |

Only the China site is served: the callback must carry `siteId=1`, and a non-`CN`
`nationalCode` is refused.

## 2. Sign-in

Not standard OAuth2 — **no PKCE, no client_secret, no `response_type`**. The browser is
sent to the sign-in page with a per-session random 32-hex `code`, and the page redirects
back to `http://127.0.0.1:<port>/callback?code=…&tempToken=…&siteId=1`. The callback
server accepts GET query params or a form-encoded POST body, must bind loopback only, and
must verify that the returned `code` equals the one it generated.

`temptoken/check` answers with **plain text** (the raw JWT), not JSON. `jwToken/check` is
the same GET that both validates and refreshes; the only difference is the `refresh`
header (`"false"` / `"true"`). It answers JSON:

```jsonc
{ "status": true,
  "userInfo": { "accessToken": "…", "refreshToken": "…", "nationalCode": "CN", "realName": true } }
```

`accessToken` lives 30 minutes. The wire never says so; 30 minutes is the measured value
used by both reference implementations, so `ACCESS_TOKEN_TTL_MS` mirrors it.

Identity comes only from the JWT payload (`userId`, `userName`, `exp`, `iat`, optional
`nationalCode` / `isRealName`). There is **no** nickname, avatar, phone, email or plan
field anywhere in this protocol.

## 3. Chat request headers

| Header | Value |
|---|---|
| `Authorization` | `Bearer <accessToken>` |
| `Content-Type` | `application/json` |
| `lang` | `en` (literal) |
| `Chat-Id` | 32 hex, stable per conversation |
| `Session-Id` | conversation key, **≤ 32 chars** |
| `x-deveco-session` | same as `Session-Id` |
| `x-deveco-task` | fresh 32 hex per turn; must match the `exitSessionQueue` call |
| `x-deveco-client` | `deveco-code@<plugin version>` |
| `x-deveco-project` / `x-deveco-parent-session` | pass-through, optional |
| `User-Agent` | a desktop Chrome UA |
| `accept-language` | `zh-CN` |
| `X-DevEco-Improvement-Enabled` | `"true"` only when the user opted in |

Conversation key: hash of the **first user message**, not `messages[0]` — `messages[0]`
is usually the system prompt, which carries dates and paths and would mint a new upstream
session on every turn (upstream then answers `403 New session request rate exceeded`).

`Session-Id` over 32 chars is rejected outright (`SSE request header Session-Id is too
long`), so upstream ids are normalised: UUIDs lose their hyphens (36 → 32), long strings
become a stable `sha256().slice(0, 32)`.

The server keeps per-`(Session-Id, Chat-Id)` queue state, so every finished turn must
`POST exitSessionQueue` — success, error and abort alike. The release has a hard 3 s
grace so a wedged release cannot stall the local queue.

## 4. Request-body rules (each one otherwise 400s or 403s)

1. `developer` role is not in the enum → rewrite to `system`.
2. `max_completion_tokens` is ignored → map to `max_tokens`; clamp to the channel's
   declared output cap (32 K for GLM).
3. `tool_choice` is an enum: `"auto" | "none" | "required"` only. An object form fails the
   whole request; emulate a forced tool with `"required"` plus a narrowed `tools` array,
   and degrade to `"auto"` when the tool is not declared.
4. `reasoning_effort` must be one the model declared, or one the channel accepts.
   GLM-5.3 declares `low|high|max` (default `high`); snap to the nearest declared tier,
   drop anything that cannot be mapped. For models declaring no tiers, standard values
   pass through and `none`/`off` become `thinking: { type: "disabled" }`.
   The two inner ("mass") models — `deepseek-v4.1-flash-1017` and `glm-5.2` — declare
   `thinking_mode: "configurable"` but **no** tier list; measured on 2026-11-20 they both
   accept `none|minimal|low|medium|high|xhigh|max` (GLM-5.2 answers a bad value with
   `reasoning_effort must be [none, minimal, low, medium, high, xhigh, max] for glm-5.2`).
   `deepseek-v4.1-flash-1017` also accepts `ultra`, GLM-5.2 does not, so `ultra` stays out
   of the shared set. `none` really does stop thinking (reasoning tokens become 0), but the
   plugin does not offer it: pi-ai sends the mapped `off` value for "no level selected" as
   well, which would silently turn thinking off for everyone who never picked a tier.
5. Thinking must be requested explicitly (`chat_template_kwargs.enable_thinking: true`).
   Otherwise GLM writes its reasoning into `content`, terminated by a stray `</think>`.
   Both inner models accept this kwarg too (verified), and `reasoning_effort: "none"`
   still wins over it, so "no effort" and "explicit thinking" do not conflict.
6. Images on a text-only model are a 403. Reroute the turn to the vision model and drop
   `tools`/`tool_choice` (that model emits tool calls as text); if only the history holds
   images, replace them with `[图片]` and keep the current model.

Channel limits: GLM-5.1 / GLM-5.3 are declared at **170 000 context / 32 000 output** on
this channel — below the public Zhipu spec. `deepseek-v4-flash` is a hidden model: it is
not in `modelConfig`, but it works, and it caps at 1 044 480 input tokens.

### Context window and output cap are independent

`context_window` is how much input fits; `output` is how many tokens one reply may emit.
A 1M-context model still stops at a few tens of thousands of output tokens.

This matters because pi-ai picks the request's ceiling from
`params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens`
(`openai-completions.js`), and reasoning content **shares** that budget with the answer.
A conservative fallback there silently truncates long replies mid-reasoning, and the
symptom is a "reached output token limit" notice that repeats after every "continue".

So `maxTokens` on a model descriptor is a channel fact, not a guess: declare the ceiling
(`DEVECO_OUTPUT_CEILING`, 32 000) whenever upstream omits `output`, never a small default.
Upstream may also send `output` as `"32K"`; expand unit suffixes before using it.

## 5. Model catalog

`codeGenie/modelConfig` returns, per account:

```jsonc
{ "code": 200,
  "body": { "inner_models": [{
    "group_name": "GLM",
    "task_default_model_map": { "small_model": "GLM-5.1", "blacklist": "Qwen3_5_…" },
    "model_configs": [{
      "model_id": "GLM-5.3",
      "thinking_mode": "on",
      "input_modalities": ["text"],
      "context_window": 170000,
      "output": "32000",
      "tool_call_mode": "tool_calls",
      "reasoning_effort": "{\"level\":[\"low\",\"high\",\"max\"],\"default\":\"high\"}"
    }, {
      "model_id": "glm-5.2",
      "thinking_mode": "configurable",
      "input_modalities": ["text"],
      "context_window": 198,
      "tool_call_mode": "tool_calls"
    }] }] } }
```

`thinking_mode` has three values: `on` (always thinks), `off` (never thinks) and
`configurable` (thinking is on by default, tiers can be requested). **`configurable` still
means a reasoning model** — the two inner models only ever publish this value, and they
do accept `reasoning_effort` even though the key is absent from their config entry.

`output` may be a string or a number. `reasoning_effort` may also be a plain JSON array on
older payloads. `task_default_model_map.blacklist` (comma-separated) removes models.

The payload also contains `body.outer_models[]` (external providers: DeepSeek, Z.ai,
DashScope, OpenAI, Anthropic, Gemini, each with its own `url` and `protocol`). This plugin
currently serves **inner models only**; `outer_models` is not parsed.

Public ids: `GLM-5.1` / `GLM-5.3` are exposed as `GLM-5.1-DevEco` / `GLM-5.3-DevEco` to
keep them distinguishable from the public Zhipu models; the wire always carries the bare
id. Everything else passes through unchanged.

## 6. There is no check-in, points or quota endpoint

A keyword sweep over both reference implementations (`checkin`, `sign-in`, `daily`,
`welfare`, `credit`, `quota`, `balance`, `points`, `积分`, `签到`, `领取`) finds **no**
DevEco endpoint for any of them. The only "sign" in the protocol is the legal-agreement
signature (`as.user.sign` on the TMS service), which is not a daily reward.

The complete endpoint inventory is: sign-in page, `temptoken/check`, `jwToken/check`,
`codeGenie/modelConfig`, the two chat paths, `exitSessionQueue`, `codeGenie/bigSearch`,
`codeGenie/cli/trace/upload`, and the two landing pages. **None of them reports a remaining
balance**, and there is no way to ask for one.

DevEco's free quota simply resets every day — **08:00 local time** according to field
reports (2026-10), not at midnight. `DEVECO_QUOTA_RESET_HOUR` overrides it in this plugin
because upstream can change it. There is nothing to claim.

So this plugin's "check-in" is a **real daily probe** instead of a fake claim button: it
fetches the model catalog for each account once a day, which proves the credential still
works, records the result, and keeps a streak. A rejected credential is marked "sign in
again" right away.

### What quota information *is* observable

| Observable | Source | Used for |
|---|---|---|
| tokens this plugin sent | `usage` in responses | the local window ledger (this machine only) |
| "out of quota" | `403` with `error.type: "UserRateLimit"`, or `FreeUsageLimitError` in the body, or `429` | per-account mark, cleared when the window rolls |
| reset boundary | 08:00 local, measured | the quota window shown in the card |

**Never** present a computed "remaining" number: there is no honest source for it. And do
not treat `403 ModelServiceError` / `Full inference timed out` as quota exhaustion — that is
someone else loading the service, not the account's quota.

Do not turn the check-in into a "claim reward" button without an endpoint to back it.

## 7. Error semantics worth preserving

- `401` → the credential is dead **only after** the retry policy is exhausted: sleep 5 s,
  refresh the token, retry the same account, at most 5 times. The delay matters because
  the token service propagates a fresh token with a short lag — refreshing immediately
  after a 401 often still returns the old state. After 5 failures the account is marked
  for re-login and the request stops.
- `403 ModelServiceError` / overload → retry on another account.
- `429` → queue/rate limit → retry on another account.
- `400` containing `too long` / `prompt length` / `maximum input length` → context
  overflow; append the channel limit hint instead of guessing.
- A `200` response can still start with an SSE frame carrying `{"error":…}`; peek the first
  frame and surface it as an error instead of letting the renderer print JSON.
