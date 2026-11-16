import { i as lazyApi, r as createProvider } from "./models-7mxFy0wO.mjs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import * as settingsModule from "@deepseek-ai/dsh-settings";
import { spawn } from "node:child_process";
// src/ttl.ts
/**
* accessToken 的**有效期自适应学习**。
*
* 上游从不告诉我们 accessToken 能活多久（token 是不透明字符串，响应里也没有 `expiresIn`），
* 之前用的 30 分钟是从参考实现沿用的一个假设。这里改成从**实际行为**里学：
*
*  1. **上界样本**：某个令牌在「签发后 A 分钟」被上游 401 拒绝 → 真实 TTL ≈ A。多来几次取中位数。
*  2. **下界样本**：某个令牌在「签发后 A 分钟」还能正常用 → TTL ≥ A。这能纠正「假设偏短」的情况。
*  3. 样本足够（≥2 个上界样本）才覆盖默认值；否则用下界把默认值往上抬；都没有就用默认 30 分钟。
*
* 「不要频繁刷新」由两处保证：一是提前量按 TTL 的比例取（并封顶 10 分钟），二是每个账号有
* 最小刷新间隔（`MIN_REFRESH_INTERVAL_MS`），同一张令牌不会被反复重刷。
*
* @module dsh-deveco/ttl
*/
/** 没有样本时的默认假设（参考实现实测值）。 */
const TTL_FALLBACK_MS = 18e5;
/** 学到的 TTL 允许范围：太小是脏样本，太大说明判据错了。 */
const TTL_MIN_MS = 18e4;
const TTL_MAX_MS = 864e5;
/**
* 闸门会不会挡住一次「到点了」的刷新。
*
* 关键算式：刷新发生在「令牌年龄 = TTL − 提前量 = 2/3·TTL」时。若 `2/3·TTL` 小于闸门间隔，
* 闸门就会把该刷的请求挡到过期之后 —— 这就是必须按 TTL 退化的原因。
*
* @param sinceLastRefreshMs 距上次刷新的毫秒数
* @param ttlMs 学到的（或默认的）令牌寿命
* @param remainingMs 当前令牌剩余寿命
* @param autoIntervalMs 主动刷新闸门（默认 5 分钟）
* @param urgentRemainingMs 紧急阈值（默认 60 秒）
* @returns true = 允许刷新
*/
function shouldRefresh(input) {
	const auto = input.autoIntervalMs ?? 3e5;
	const urgent = input.urgentRemainingMs ?? 6e4;
	if (input.sinceLastRefreshMs >= auto) return {
		allowed: true,
		reason: "interval-ok"
	};
	if (input.remainingMs <= urgent) return {
		allowed: true,
		reason: "urgent"
	};
	if (Math.round(input.ttlMs * 2 / 3) < auto) return {
		allowed: true,
		reason: "short-ttl"
	};
	return {
		allowed: false,
		reason: "throttled"
	};
}
/** 提前量上限（沿用原来的 10 分钟）。 */
const MAX_REFRESH_SKEW_MS = 6e5;
/** 提前量下限：太小的提前量等于没有。 */
const MIN_REFRESH_SKEW_MS = 12e4;
function clamp(value, low, high) {
	return Math.min(high, Math.max(low, value));
}
/** 中位数（偶数个取中间两数的均值）。 */
function median(values) {
	if (values.length === 0) return void 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
/**
* 估算 accessToken 的 TTL。
*
* 优先用上界样本（最接近真相）；样本不足时用下界抬高默认值；都没有就用默认。
*/
function estimateTtlMs(input) {
	const fallback = clamp(input.fallbackMs ?? 18e5, TTL_MIN_MS, TTL_MAX_MS);
	const expired = (input.expiredAgesMs ?? []).filter((age) => Number.isFinite(age) && age >= 18e4 && age <= 864e5);
	if (expired.length >= 2) {
		const ttl = median(expired);
		if (ttl !== void 0) return {
			ttlMs: clamp(ttl, TTL_MIN_MS, TTL_MAX_MS),
			source: "learned",
			samples: expired.length
		};
	}
	const working = input.workingAgeMs ?? 0;
	if (Number.isFinite(working) && working > fallback && working <= 864e5) return {
		ttlMs: clamp(Math.round(working * 1.1), TTL_MIN_MS, TTL_MAX_MS),
		source: "extended",
		samples: expired.length
	};
	return {
		ttlMs: fallback,
		source: "default",
		samples: expired.length
	};
}
/**
* 由 TTL 推导提前量：按比例取（1/3），并夹在 [2 分钟, 10 分钟]。
*
* 这样「学到的 TTL 很短」时会自动更早续期，而 TTL 很长时也不会无脑提前 10 分钟以上，
* 减少不必要的刷新。
*/
function refreshSkewForTtl(ttlMs, configuredSkewMs = MAX_REFRESH_SKEW_MS) {
	const proportional = Math.round(ttlMs / 3);
	const upper = clamp(configuredSkewMs, MIN_REFRESH_SKEW_MS, MAX_REFRESH_SKEW_MS);
	return clamp(proportional, MIN_REFRESH_SKEW_MS, upper);
}
/** 追加一个上界样本（保留最近 `TTL_SAMPLE_KEEP` 个）。 */
function pushTtlSample(samples, sampleMs) {
	return [...samples ?? [], Math.round(sampleMs)].filter((age) => age >= 18e4 && age <= 864e5).slice(-5);
}
// src/version.ts
/** 构建时由 tsdown 注入的包版本；直接跑源码（测试/调试）时退化成 dev 标记。 */
const DEVECO_VERSION = "0.1.1";
// src/config.ts
/**
* DevEco（华为 CodeGenie MaaS）的协议常量。
*
* 这一份是「上游事实」的唯一出处：主机名、路径、OAuth 参数、必需请求头、渠道上限。
* 业务代码只引用这里，不自己拼字符串 —— 上游换路径时只要改这一个文件。
*
* 数据来源与实测记录见 `docs/PROTOCOL.md`。
*
* @module dsh-deveco/config
*/
/** 上游站点根。仅中国站可用（登录回调的 `siteId` 必须是 `1`）。 */
const DEVECO_BASE_URL = "https://cn.devecostudio.huawei.com";
/** OpenAI 兼容的模型 API 前缀（流式）。 */
const DEVECO_API_BASE = `${DEVECO_BASE_URL}/sse/codeGenie/maas/v2`;
/** 动态模型目录。 */
const DEVECO_MODEL_CONFIG_URL = `${DEVECO_BASE_URL}/codeGenie/modelConfig`;
/** 释放服务端排队槽位。 */
const DEVECO_EXIT_QUEUE_URL = `${DEVECO_BASE_URL}/sse/codeGenie/exitSessionQueue`;
/** 登录页（浏览器打开）。 */
const DEVECO_AUTH_URL = `${DEVECO_BASE_URL}/console/DevEcoIDE/apply`;
/** tempToken → jwtToken。 */
const DEVECO_TEMP_TOKEN_URL = `${DEVECO_BASE_URL}/authrouter/auth/api/temptoken/check`;
/** jwtToken 校验 / 续期 / 换 accessToken（同一个接口，靠 `refresh` 头区分）。 */
const DEVECO_JWT_TOKEN_URL = `${DEVECO_BASE_URL}/authrouter/auth/api/jwToken/check`;
/** 登录成功后浏览器回跳的落地页。 */
const DEVECO_SUCCESS_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginSuccess`;
/** 登录失败/取消后浏览器回跳的落地页。 */
const DEVECO_FAILED_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginFailed`;
/** 登录页要求的 appId（写死在上游前端里）。 */
const DEVECO_APP_ID = "1008";
/** 回调服务端口候选。DevEco 只在 127.0.0.1 上等这几个口。 */
const DEVECO_CALLBACK_PORTS = [
	10101,
	34567,
	34568,
	34569,
	34570
];
/** 等用户点完登录的总预算。 */
const LOGIN_TIMEOUT_MS = 6e5;
/** 登录/token 这类控制面请求的超时。 */
const CONTROL_TIMEOUT_MS = 2e4;
/** accessToken 的固定有效期：上游不给 TTL，实测 30 分钟。 */
const ACCESS_TOKEN_TTL_MS = 18e5;
/**
* 只在用户**显式设置** `DEVECO_REFRESH_SKEW_MINUTES` 时返回该值（毫秒）。
*
* 自适应学习默认按「学到的 TTL / 3」决定提前量；显式设置则视为运维的强制覆盖，
* 优先级高于学习结果（这也是唯一的逃生口）。
*/
function refreshSkewOverrideMs() {
	const raw = process.env.DEVECO_REFRESH_SKEW_MINUTES;
	if (raw === void 0 || raw.trim() === "") return void 0;
	const minutes = Number(raw);
	if (!Number.isFinite(minutes) || minutes < 0) return void 0;
	return minutes * 6e4;
}
/** 续期失败后的冷却，避免每个请求都去打上游。 */
const REFRESH_COOLDOWN_MS = 3e4;
/**
* 令牌**真的过期**、且有刷新正在进行时，请求最多等多久。
*
* 只在这种情况下等待：旧令牌还能用就绝不等待（那只会平白增加延迟）。上限取 10 秒，
* 因为最坏路径是「401 恢复：5 秒等待 + 刷新」，不能让后续请求被拖到 DSH 侧超时。
*/
const AUTH_WAIT_FOR_REFRESH_MS = 1e4;
/** 控制面请求用的浏览器 UA（上游按 UA 判客户端）。 */
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** 聊天请求里的客户端标识：`deveco-code@<version>`。 */
const DEVECO_CLIENT_TAG = `deveco-code@${DEVECO_VERSION}`;
/** GLM 渠道声明上限（低于智谱官方规格，以渠道为准）。 */
const DEVECO_GLM_CONTEXT_LIMIT = 17e4;
const DEVECO_GLM_OUTPUT_LIMIT = 32e3;
/** 未声明上限时的兜底（上下文窗口）。 */
const DEFAULT_CONTEXT_WINDOW = 32768;
/** 兜底的单次输出上限：只给「确实知道上限」的模型用（如视觉模型 8K）。 */
const DEFAULT_MAX_TOKENS = 8192;
/**
* 渠道级输出上限。
*
* 这是**输出**（max_tokens）的上限，和上下文窗口无关 —— 1M 上下文的模型也照样只能
* 一次输出这么多。上游对 GLM 明确声明 32K；其余模型没有单独声明时按同一个上限处理。
*
* 为什么要有一个统一上限：pi-ai 在请求没带 `max_tokens` 时，直接拿模型描述里的
* `maxTokens` 当上限（见 `openai-completions.js` 的 `ceiling`）。如果这里给了一个
* 保守的小值（以前是 8192），长回答会在 8K 处被截断，而推理内容与正文**共享**这个
* 额度 —— 表现就是「推理到一半提示输出 token 上限」。
*/
const DEVECO_OUTPUT_CEILING = 32e3;
/**
* 当前生效的输出上限。
*
* 可用 `DEVECO_MAX_OUTPUT_TOKENS` 覆盖：上游若是放宽了单次输出，不必改代码。
* 注意这个值只能**调低/对齐**渠道；设得比渠道实际允许的更大，上游会直接 400。
*/
function outputCeiling() {
	return envNumber("DEVECO_MAX_OUTPUT_TOKENS", DEVECO_OUTPUT_CEILING);
}
/**
* 隐藏模型：不在模型目录里，但确实能调。用户手工写进 `enabledModels`
* 或对话模型选择里仍然可用。
*/
const HIDDEN_MODEL_IDS = ["deepseek-v4-flash"];
/**
* 对外模型 id ↔ 上游 wire id。
*
* 上游注册名是 `GLM-5.1` / `GLM-5.3`；对外加 `-DevEco` 后缀是为了和智谱公版区分，
* 避免用户在模型下拉里选错。裸 id 仍然作为兼容别名接受。
*/
const DEVECO_EXPOSED_MODEL_IDS = {
	"GLM-5.1": "GLM-5.1-DevEco",
	"GLM-5.3": "GLM-5.3-DevEco"
};
/** 视觉模型：纯文本模型收到图片会被上游 403，需改路由到这条。 */
const DEFAULT_VISION_MODEL = "Qwen3_5_397B_A17B_w8a8_single";
/** 对外暴露的 id（`GLM-5.1` → `GLM-5.1-DevEco`）。幂等。 */
function exposedModelId(id) {
	return DEVECO_EXPOSED_MODEL_IDS[id] ?? id;
}
/** 还原成上游 wire id（`GLM-5.1-DevEco` → `GLM-5.1`）。幂等。 */
function upstreamModelId(id) {
	const trimmed = id.trim();
	for (const [upstream, exposed] of Object.entries(DEVECO_EXPOSED_MODEL_IDS)) if (exposed.toLowerCase() === trimmed.toLowerCase()) return upstream;
	return trimmed;
}
/** 该模型在渠道上声明的窗口/输出上限；未声明返回 undefined。 */
function channelLimitsFor(id) {
	const wire = upstreamModelId(id);
	return DEVECO_MODEL_LIMITS[wire];
}
/**
* 渠道声明上限表（按上游 wire id）。
*
* `output` 是**单次输出**上限，`context` 是上下文窗口。上游对 GLM 系声明
* 170000/32000；deepseek 系未单独声明输出，按 `DEVECO_OUTPUT_CEILING` 处理。
*/
const DEVECO_MODEL_LIMITS = {
	"GLM-5.1": {
		context: DEVECO_GLM_CONTEXT_LIMIT,
		output: DEVECO_GLM_OUTPUT_LIMIT
	},
	"GLM-5.3": {
		context: DEVECO_GLM_CONTEXT_LIMIT,
		output: DEVECO_GLM_OUTPUT_LIMIT
	},
	"GLM-5.2": {
		context: 202752,
		output: DEVECO_OUTPUT_CEILING
	},
	"deepseek-v4.1-flash-1017": {
		context: 1048576,
		output: DEVECO_OUTPUT_CEILING
	},
	"deepseek-v4-flash": {
		context: 1044480,
		output: DEVECO_OUTPUT_CEILING
	}
};
const DEFAULT_QUEUE_COOLDOWN_MS = 1e3;
/** 等上游开流时的空闲超时：沉默这么久才判死。不能用总时长超时。 */
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 12e4;
/** exitSessionQueue 的等待上限：放槽位失败不该把队列卡住。 */
const EXIT_QUEUE_GRACE_MS = 3e3;
/** 环境变量读取（空串视作未设置）。 */
function envNumber(name, fallback) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}
// src/auth.ts
/**
* DevEco 凭证体系：多账号文档 + 单账号续期。
*
* 三层的生命周期各不相同（见 `docs/PROTOCOL.md`）：
*
* | 凭证 | 谁签发 | 寿命 | 存哪 |
* |---|---|---|---|
* | `jwtToken` | `authrouter/temptoken/check` | 天/周级（JWT `exp`） | 磁盘（本文件） |
* | `accessToken` | `authrouter/jwToken/check?refresh` | 30 分钟（上游不给 TTL，实测） | 磁盘 + 内存，过期即续 |
* | 浏览器授权 `code` | DevEco 登录页 | 一次 | 只在登录过程中存在 |
*
* **多账号**：文档 `.deveco-accounts.json` 管凭证，池（`account-pool.ts`）管「谁现在能接活」。
* 每个账号一份 `AccountSlot`，续期是单飞的 —— 同一个账号并发刷新会让后到的那次拿着
* 已轮换的 refreshToken 失败，把好端端的账号写成 stale。
*
* @module dsh-deveco/auth
*/
/** 数据目录：默认 `~/.dsh`（与宿主一致），可用 `DSH_HOME` 覆盖。 */
function devecoHome(home) {
	return home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** 多账号文档路径。 */
function devecoAccountsPath(home) {
	return join(devecoHome(home), ".deveco-accounts.json");
}
/** 签到台账路径。 */
function devecoCheckinPath(home) {
	return join(devecoHome(home), ".deveco-checkin.json");
}
/** 用量台账路径。 */
function devecoUsagePath(home) {
	return join(devecoHome(home), ".deveco-usage.json");
}
/** 续期失败日志路径（宿主对插件 debug 日志没有出口，失败原因只能自己留档）。 */
function devecoRefreshLogPath(home) {
	return join(devecoHome(home), ".deveco-refresh.log");
}
/** 解析 JWT 载荷。**不验签**：上游的签名密钥我们拿不到，也没必要验。 */
function parseJwtPayload(token) {
	const parts = token.trim().split(".");
	if (parts.length !== 3) throw new Error("not a jwtToken (expected 3 dot-separated parts)");
	const base64Url = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64Url.padEnd(base64Url.length + (4 - base64Url.length % 4) % 4, "=");
	const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
	const payload = {};
	if (typeof parsed.userId === "string" && parsed.userId !== "") payload.userId = parsed.userId;
	if (typeof parsed.userName === "string" && parsed.userName !== "") payload.userName = parsed.userName;
	if (typeof parsed.exp === "number") payload.exp = parsed.exp;
	if (typeof parsed.iat === "number") payload.iat = parsed.iat;
	if (typeof parsed.nationalCode === "string" && parsed.nationalCode !== "") payload.nationalCode = parsed.nationalCode;
	if (typeof parsed.isRealName === "boolean") payload.isRealName = parsed.isRealName;
	return payload;
}
/** 账号自然键：`userId` → `userName` → jwtToken 哈希。 */
function accountIdOf(credential) {
	if (typeof credential.userId === "string" && credential.userId !== "") return credential.userId;
	if (typeof credential.userName === "string" && credential.userName !== "") return credential.userName;
	return `t${createHash("sha256").update(credential.jwtToken).digest("hex").slice(0, 15)}`;
}
/** 用 JWT 载荷补全凭证里的身份字段。 */
function withJwtIdentity(credential) {
	let payload;
	try {
		payload = parseJwtPayload(credential.jwtToken);
	} catch {
		return credential;
	}
	return {
		...credential,
		...payload.userId === void 0 ? {} : { userId: payload.userId },
		...payload.userName === void 0 ? {} : { userName: payload.userName },
		...payload.nationalCode === void 0 ? {} : { nationalCode: payload.nationalCode },
		...payload.isRealName === void 0 ? {} : { isRealName: payload.isRealName }
	};
}
/** 账号摘要。 */
function summarizeAccount(id, credential) {
	let jwtExpiresAt;
	try {
		const exp = parseJwtPayload(credential.jwtToken).exp;
		if (exp !== void 0) jwtExpiresAt = exp * 1e3;
	} catch {
		jwtExpiresAt = void 0;
	}
	const ttl = estimateTtlMs({
		expiredAgesMs: credential.ttlSamplesMs,
		workingAgeMs: credential.workingAgeMs
	});
	const tokenAgeMs = credential.accessTokenIssuedAt === void 0 ? void 0 : Math.max(0, Date.now() - credential.accessTokenIssuedAt);
	return {
		id,
		...credential.label === void 0 ? {} : { label: credential.label },
		...credential.userName === void 0 ? {} : { userName: credential.userName },
		...credential.userId === void 0 ? {} : { userId: credential.userId },
		...credential.nationalCode === void 0 ? {} : { nationalCode: credential.nationalCode },
		isRealName: credential.isRealName === true,
		usable: credential.stale !== true,
		ttlMs: ttl.ttlMs,
		ttlSource: ttl.source,
		ttlSamples: ttl.samples,
		...tokenAgeMs === void 0 ? {} : { tokenAgeMs },
		...credential.accessTokenExpiresAt === void 0 ? {} : { accessTokenExpiresAt: credential.accessTokenExpiresAt },
		...credential.storedAt === void 0 ? {} : { storedAt: credential.storedAt },
		...credential.lastLoginAt === void 0 ? {} : { lastLoginAt: credential.lastLoginAt },
		...jwtExpiresAt === void 0 ? {} : { jwtExpiresAt },
		paused: credential.paused === true,
		pinned: credential.pinned === true
	};
}
/** `realName` 上游有时给布尔、有时给字符串，统一成布尔。 */
function parseRealName(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
}
/** 原子写文件（临时文件 + rename），并尽力收紧权限。 */
function writeJsonAtomic(path, value) {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, void 0, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	renameSync(temp, path);
	try {
		chmodSync(path, 384);
	} catch {}
}
function readJsonFile(path) {
	try {
		if (!existsSync(path)) return void 0;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
/**
* 校验 + 续期一个账号的访问令牌（单飞）。
*
* 为什么必须单飞：`refreshToken` 是一次性的，上游刷新时会轮换它。两个并发刷新里
* 后发的那次拿着已作废的值，会把整个账号写成 stale —— 症状正是「隔天就要重新登录」。
*/
var AccountSlot = class {
	cred;
	inflight;
	generation = 0;
	blockedUntil = 0;
	/** 上次真正打上游刷新的时刻（最小刷新间隔用）。 */
	lastRefreshAt = 0;
	persist;
	log;
	constructor(credential, persist, log) {
		this.cred = credential;
		this.persist = persist;
		this.log = log;
	}
	current() {
		return this.cred;
	}
	replace(credential) {
		this.cred = credential;
		this.generation += 1;
	}
	/**
	* 当前凭证是否已被判定失效。
	*
	* 用方法而不是直接比较属性：`refresh()` 会改写 `this.cred`，而 TS 对属性的窄化会把
	* 刷新之后的 `=== true` 比较当成「没有交集」而报错。
	*/
	isStale() {
		return this.cred.stale === true;
	}
	/** 访问令牌还能用多久（毫秒）；没有或已过期 ≤ 0。 */
	remainingMs() {
		const expiresAt = this.cred.accessTokenExpiresAt;
		if (typeof this.cred.accessToken !== "string" || this.cred.accessToken === "") return 0;
		if (expiresAt === void 0) return 0;
		return expiresAt - Date.now();
	}
	/** 当前生效的 accessToken 寿命（学到的或默认）。 */
	ttlMs() {
		return estimateTtlMs({
			expiredAgesMs: this.cred.ttlSamplesMs,
			workingAgeMs: this.cred.workingAgeMs
		}).ttlMs;
	}
	/**
	* 续期提前量。
	*
	* 默认跟着**学到的 TTL** 走（TTL/3，夹在 2–10 分钟），所以 TTL 学得越准、刷新越少。
	* 显式设置 `DEVECO_REFRESH_SKEW_MINUTES` 时以它为准（运维逃生口），但仍不允许超过 TTL/2，
	* 否则就变成「刚拿到就作废」的刷新风暴。
	*/
	skewMs() {
		const ttl = this.ttlMs();
		const override = refreshSkewOverrideMs();
		if (override === void 0) return refreshSkewForTtl(ttl);
		return Math.min(override, Math.max(MIN_REFRESH_SKEW_MS, Math.floor(ttl / 2)));
	}
	/**
	* 用号前检查：拿一个当前可用的访问令牌。
	*
	* 规则（这是「动态控制有效期」的落点，每次从池里取号发请求前都会走一遍）：
	*  - 剩余寿命 > 提前量 → 直接用。提前量由**学到的 TTL** 推出来（TTL/3，夹在 2–10 分钟），
	*    所以 TTL 学得越准，刷新越少；
	*  - 剩余 ≤ 提前量（含没有过期时间、令牌为空、已经过期）→ 先刷新再返回，但受
	*    `MIN_REFRESH_INTERVAL_MS` 约束，同一张令牌不会被反复重刷；
	*  - 刷新被上游明确拒绝（JWT 过期 / 401）→ 标 stale，返回 undefined，让上层换号；
	*  - 刷新因为网络抖动失败 → 只进冷却，**不判死账号**；只要旧令牌还没真过期就先用它。
	*
	* @returns 令牌；确实是「必须重新登录」时返回 undefined。
	*/
	async accessToken() {
		if (this.isStale()) return void 0;
		const remaining = this.remainingMs();
		if (remaining > this.skewMs()) {
			this.noteWorkingAge();
			return this.cred.accessToken;
		}
		const now = Date.now();
		const gate = shouldRefresh({
			sinceLastRefreshMs: this.lastRefreshAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastRefreshAt,
			ttlMs: this.ttlMs(),
			remainingMs: remaining
		});
		if (now >= this.blockedUntil && gate.allowed) {
			this.inflight ??= this.refresh().finally(() => {
				this.inflight = void 0;
			});
			const outcome = await this.inflight;
			if (outcome !== void 0) return outcome.accessToken;
		}
		if (this.isStale()) return void 0;
		if (remaining > 0 && typeof this.cred.accessToken === "string" && this.cred.accessToken !== "") {
			this.noteWorkingAge();
			return this.cred.accessToken;
		}
		if (this.inflight !== void 0) {
			const settled = await this.waitForInflight(AUTH_WAIT_FOR_REFRESH_MS);
			if (settled !== void 0) return settled;
		}
	}
	/** 等一个正在进行的刷新，最多 `maxMs`；超时返回 undefined。 */
	async waitForInflight(maxMs) {
		const inflight = this.inflight;
		if (inflight === void 0) return void 0;
		return (await Promise.race([inflight, new Promise((resolve) => {
			setTimeout(() => resolve(void 0), maxMs).unref?.();
		})]))?.accessToken;
	}
	/**
	* 记录「这张令牌已经活了这么久且仍可用」—— TTL 的下界。
	*
	* 只在明显超过当前假设时才落盘，避免每条请求都写文件。
	*/
	noteWorkingAge() {
		const issuedAt = this.cred.accessTokenIssuedAt;
		if (issuedAt === void 0) return;
		const age = Date.now() - issuedAt;
		if (age <= (this.cred.workingAgeMs ?? 0) || age <= this.ttlMs()) return;
		this.cred = {
			...this.cred,
			workingAgeMs: age
		};
		this.persist(this.cred);
	}
	/**
	* 上游**接受**了这张令牌 —— TTL 的下界样本。
	*
	* 判据是「实际年龄超过当前估值却还能用」，说明我们估小了。由 shim 在请求成功后调用，
	* 传进来的 `issuedAt` 是**这次请求实际使用的那张令牌**的签发时刻（不是当前 slot 里的，
	* 因为期间可能已经刷新过）。
	*/
	noteTokenWorked(issuedAt) {
		const issued = issuedAt ?? this.cred.accessTokenIssuedAt;
		if (issued === void 0) return;
		const age = Date.now() - issued;
		if (age <= 0 || age <= (this.cred.workingAgeMs ?? 0) || age <= this.ttlMs()) return;
		this.cred = {
			...this.cred,
			workingAgeMs: age
		};
		this.persist(this.cred);
		this.log?.(`token outlived the TTL estimate; raising it to ${Math.round(this.ttlMs() / 6e4)}min`);
	}
	/**
	* 上游拿这张令牌回了 401 —— 这是 TTL 的**上界样本**。
	*
	* 只在「令牌是本地签发的、且没有被别的路径替换过」时采信：如果签发时刻缺失或为负，
	* 说明这是从磁盘读来的旧令牌，年龄不可信，宁可不要这个样本。
	*/
	recordExpiredToken() {
		const issuedAt = this.cred.accessTokenIssuedAt;
		if (issuedAt === void 0) return;
		const age = Date.now() - issuedAt;
		if (age <= 0) return;
		const samples = pushTtlSample(this.cred.ttlSamplesMs, age);
		if (samples.length === (this.cred.ttlSamplesMs ?? []).length) return;
		this.cred = {
			...this.cred,
			ttlSamplesMs: samples
		};
		this.persist(this.cred);
		const ttl = this.ttlMs();
		this.log?.(`learned a token lifetime sample: ${Math.round(age / 6e4)}min (ttl now ~${Math.round(ttl / 6e4)}min from ${samples.length} sample(s))`);
	}
	/** 强制续期一次（用户点「刷新凭证」/聊天 401 后重试）。 */
	async forceRefresh() {
		this.inflight ??= this.refresh(true).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	async refresh(force = false) {
		const seen = this.cred.jwtToken;
		const generation = this.generation;
		let jwtExpired = false;
		try {
			const exp = parseJwtPayload(seen).exp;
			if (exp !== void 0 && Date.now() >= exp * 1e3) jwtExpired = true;
		} catch {
			jwtExpired = true;
		}
		if (jwtExpired) {
			this.markStale("jwtToken expired; sign in again");
			return;
		}
		this.lastRefreshAt = Date.now();
		const outcome = await requestTokenRefresh(seen);
		if (!outcome.ok) {
			if (generation === this.generation) {
				this.blockedUntil = Date.now() + REFRESH_COOLDOWN_MS;
				this.log?.(`refresh ${outcome.kind}: ${outcome.message}`);
				if (outcome.kind === "rejected" && force && generation === this.generation) this.markStale(`refresh rejected by upstream: ${outcome.message}`);
			}
			return;
		}
		const value = outcome.value;
		const issuedAt = Date.now();
		const next = withJwtIdentity({
			...this.cred,
			accessToken: value.accessToken,
			accessTokenIssuedAt: issuedAt,
			accessTokenExpiresAt: issuedAt + this.ttlMs(),
			...value.refreshToken === void 0 ? {} : { refreshToken: value.refreshToken },
			...value.isRealName === void 0 ? {} : { isRealName: value.isRealName },
			stale: false
		});
		this.cred = next;
		this.generation += 1;
		this.blockedUntil = 0;
		this.persist(next);
		return value;
	}
	markStale(reason) {
		if (this.cred.stale === true) return;
		this.cred = {
			...this.cred,
			stale: true
		};
		this.generation += 1;
		this.persist(this.cred);
		this.log?.(`account marked stale: ${reason}`);
	}
	/** 记一次上游明确否定了这条凭证（401 / 403 ModelServiceError）。 */
	noteRejected(reason) {
		this.markStale(reason);
	}
};
/**
* 向 `jwToken/check` 要一个新访问令牌。
*
* 上游用**同一个 GET** 同时承担「校验 JWT」和「换 accessToken」，区别只有 `refresh` 头。
* 请求没有 body，JWT 放在 `jwtToken` 头里（注意是小写开头的驼峰，不是 `Authorization`）。
*
* @returns 明确的成功/拒绝/暂时失败三态。**网络失败与上游拒绝必须分开**，否则一次超时
*          就会被上层当作「密钥无效」，把还能用的账号写死。
*/
async function requestTokenRefresh(jwtToken, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
	timer.unref?.();
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const response = await fetch(DEVECO_JWT_TOKEN_URL, {
			method: "GET",
			headers: {
				refresh: "true",
				jwtToken,
				"accept-language": "zh-CN"
			},
			signal: controller.signal
		});
		if (response.status === 401 || response.status === 403) return {
			ok: false,
			kind: "rejected",
			message: `HTTP ${response.status}`
		};
		if (!response.ok) return {
			ok: false,
			kind: "transient",
			message: `HTTP ${response.status}`
		};
		const body = await response.json();
		const accessToken = body.userInfo?.accessToken;
		if (body.status !== true || typeof accessToken !== "string" || accessToken === "") {
			const errorCode = typeof body.errorCode === "number" ? body.errorCode : void 0;
			const text = [typeof body.errorMsg === "string" && body.errorMsg !== "" ? body.errorMsg : void 0, errorCode === void 0 ? void 0 : `errorCode ${errorCode}`].filter((part) => part !== void 0).join(" ") || "refresh returned status=false";
			return {
				ok: false,
				kind: errorCode === 4016 || /invalid|expired|unauthor|forbidden/i.test(text) ? "rejected" : "transient",
				message: text
			};
		}
		const value = { accessToken };
		if (typeof body.userInfo?.refreshToken === "string" && body.userInfo.refreshToken !== "") value.refreshToken = body.userInfo.refreshToken;
		const realName = parseRealName(body.userInfo?.realName);
		if (realName !== void 0) value.isRealName = realName;
		return {
			ok: true,
			value
		};
	} catch (error) {
		return {
			ok: false,
			kind: "transient",
			message: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* 多账号凭证文档。
*
* 文档本身只管「存了什么」；能不能用由池和 slot 决定。
*/
var DevecoAccountStore = class {
	path;
	log;
	document;
	loading;
	slots = /* @__PURE__ */ new Map();
	constructor(path, options = {}) {
		this.path = path;
		this.log = options.log;
	}
	/** 当前磁盘路径（部署/诊断用）。 */
	get documentPath() {
		return this.path;
	}
	async ensureLoaded() {
		if (this.document !== void 0) return;
		this.loading ??= this.load();
		await this.loading;
	}
	async load() {
		const raw = readJsonFile(this.path);
		const accounts = {};
		for (const [id, value] of Object.entries(raw?.accounts ?? {})) {
			if (value === null || typeof value !== "object") continue;
			const credential = value;
			if (typeof credential.jwtToken !== "string" || credential.jwtToken === "") continue;
			try {
				parseJwtPayload(credential.jwtToken);
			} catch {
				continue;
			}
			accounts[id] = withJwtIdentity(credential);
		}
		const order = Array.isArray(raw?.order) ? raw.order.filter((id) => typeof id === "string" && accounts[id] !== void 0) : [];
		for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id);
		this.document = {
			version: 1,
			order,
			accounts
		};
	}
	get doc() {
		if (this.document === void 0) this.document = {
			version: 1,
			order: [],
			accounts: {}
		};
		return this.document;
	}
	flush() {
		writeJsonAtomic(this.path, this.doc);
	}
	slot(id, credential) {
		const existing = this.slots.get(id);
		if (existing !== void 0) return existing;
		const slot = new AccountSlot(credential, (next) => {
			this.doc.accounts[id] = next;
			this.flush();
		}, this.log);
		this.slots.set(id, slot);
		return slot;
	}
	/** 账号摘要列表（按文档顺序）。 */
	async list() {
		await this.ensureLoaded();
		const doc = this.doc;
		return doc.order.map((id) => {
			const credential = doc.accounts[id];
			return credential === void 0 ? void 0 : summarizeAccount(id, credential);
		}).filter((entry) => entry !== void 0);
	}
	/** 账号 id 列表（文档顺序）。 */
	async ids() {
		await this.ensureLoaded();
		return [...this.doc.order];
	}
	/** 账号 id 列表，但按当前凭证可用性过滤（stale 的不参与轮转）。 */
	async dispatchIds() {
		await this.ensureLoaded();
		const doc = this.doc;
		return doc.order.filter((id) => {
			const credential = doc.accounts[id];
			return credential !== void 0 && credential.stale !== true && credential.paused !== true;
		});
	}
	/** 某个账号的凭证副本。 */
	async credential(id) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		return credential === void 0 ? void 0 : { ...credential };
	}
	/** 第一个可用账号的凭证。 */
	async current() {
		const id = (await this.dispatchIds())[0];
		if (id === void 0) return void 0;
		const credential = await this.credential(id);
		return credential === void 0 ? void 0 : {
			id,
			credential
		};
	}
	/** 有没有任何账号。 */
	async hasCredential() {
		return (await this.ids()).length > 0;
	}
	/** 写入/更新一个账号，返回账号 id。 */
	async upsert(credential, id) {
		await this.ensureLoaded();
		const doc = this.doc;
		const normalized = withJwtIdentity({
			...credential,
			storedAt: credential.storedAt ?? Date.now()
		});
		const key = id ?? accountIdOf(normalized);
		const previous = doc.accounts[key];
		doc.accounts[key] = {
			...normalized,
			...previous?.label === void 0 ? {} : { label: normalized.label ?? previous.label },
			...previous?.paused === void 0 ? {} : { paused: previous.paused },
			...previous?.pinned === void 0 ? {} : { pinned: previous.pinned },
			stale: false
		};
		if (!doc.order.includes(key)) doc.order.push(key);
		this.slots.get(key)?.replace(doc.accounts[key]);
		this.flush();
		return key;
	}
	/** 删除一个账号。 */
	async remove(id) {
		await this.ensureLoaded();
		const doc = this.doc;
		if (doc.accounts[id] === void 0) return;
		delete doc.accounts[id];
		doc.order = doc.order.filter((entry) => entry !== id);
		this.slots.delete(id);
		this.flush();
	}
	/** 清空所有账号。 */
	async clear() {
		await this.ensureLoaded();
		this.document = {
			version: 1,
			order: [],
			accounts: {}
		};
		this.slots.clear();
		this.flush();
	}
	/** 暂停/恢复一个账号。 */
	async setPaused(id, paused) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return false;
		this.doc.accounts[id] = {
			...credential,
			paused
		};
		this.slots.get(id)?.replace(this.doc.accounts[id]);
		this.flush();
		return true;
	}
	/** 置顶/取消置顶一个账号。 */
	async setPinned(id, pinned) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return false;
		this.doc.accounts[id] = {
			...credential,
			pinned
		};
		this.slots.get(id)?.replace(this.doc.accounts[id]);
		this.flush();
		return true;
	}
	/** 改备注名。 */
	async setLabel(id, label) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return false;
		const trimmed = label.trim();
		this.doc.accounts[id] = trimmed === "" ? (() => {
			const { label: _dropped, ...rest } = credential;
			return rest;
		})() : {
			...credential,
			label: trimmed
		};
		this.slots.get(id)?.replace(this.doc.accounts[id]);
		this.flush();
		return true;
	}
	/**
	* 解析一个账号，拿到可直接用的访问令牌（必要时静默续期）。
	*
	* @returns 解析结果；账号不存在、被暂停或确实需要重新登录时 undefined。
	*/
	async resolve(id) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return void 0;
		const slot = this.slot(id, credential);
		const accessToken = await slot.accessToken();
		if (accessToken === void 0) return void 0;
		const fresh = slot.current();
		return {
			id,
			credential: fresh,
			accessToken,
			...fresh.userName === void 0 ? {} : { userName: fresh.userName },
			...fresh.userId === void 0 ? {} : { userId: fresh.userId }
		};
	}
	/** 强制续期一个账号（卡片上的「刷新凭证」按钮）。 */
	async forceRefresh(id) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return false;
		return await this.slot(id, credential).forceRefresh() !== void 0;
	}
	/** 上游明确拒了这条凭证：标成 stale，等用户重新登录。 */
	async markRejected(id, reason) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return;
		this.slot(id, credential).noteRejected(reason);
	}
	/**
	* 上游拿这张 accessToken 回了 401 —— 交给 slot 记一个 TTL 上界样本。
	*
	* 只采样、不改账号状态：是否判死由调用方根据「刷新能否成功」决定。
	*/
	async noteTokenWorked(id, issuedAt) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return;
		this.slot(id, credential).noteTokenWorked(issuedAt);
	}
	async noteTokenExpired(id) {
		await this.ensureLoaded();
		const credential = this.doc.accounts[id];
		if (credential === void 0) return;
		this.slot(id, credential).recordExpiredToken();
	}
	/** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
	async reloadFromDisk() {
		const before = JSON.stringify(this.doc);
		this.document = void 0;
		this.loading = void 0;
		this.slots.clear();
		await this.ensureLoaded();
		return JSON.stringify(this.doc) !== before;
	}
	/**
	* 保活：把所有「访问令牌快过期」的账号提前续掉。
	*
	* 这一轮**只续 accessToken**，不动 jwtToken 的寿命 —— jwtToken 什么时候过期由上游
	* 决定，过期只能重新登录。它的价值是：DSH 开机放一整天不聊天时，第一个请求不必
	* 先等一次续期，同时把「哪个号已经废了」提前暴露在卡片上。
	*/
	/**
	* @param options.skip 返回 true 的账号本轮不碰。
	*
	* 后台续期最忌讳「账号正有请求在飞时给它换令牌」：很多网关签发新 accessToken 就会让
	* 旧的那张失效，正在流式输出的请求会当场被上游判「密钥无效」而中断 —— 这正是
	* 「推理到一半突然密钥无效」的典型来源。所以有在飞请求的账号一律跳过，等它空下来。
	*/
	async keepAlive(options = {}) {
		await this.ensureLoaded();
		const ids = this.doc.order.filter((id) => this.doc.accounts[id]?.stale !== true && options.skip?.(id) !== true);
		let refreshed = 0;
		const needsLogin = [];
		for (const id of ids) {
			const credential = this.doc.accounts[id];
			if (credential === void 0) continue;
			const slot = this.slot(id, credential);
			const before = slot.current().accessToken;
			const token = await slot.accessToken();
			if (token === void 0) {
				needsLogin.push(id);
				continue;
			}
			if (token !== before) refreshed += 1;
		}
		return {
			checked: ids.length,
			refreshed,
			needsLogin
		};
	}
};
var DevecoAccountPool = class {
	accounts = /* @__PURE__ */ new Map();
	/** 用户手动暂停的账号：运行时状态留着（卡片还看得见槽位），但不参与轮转。 */
	paused = /* @__PURE__ */ new Set();
	/** 用户置顶的账号：选号时排在最前面。 */
	preferred = /* @__PURE__ */ new Set();
	maxConcurrent;
	now;
	/** 等槽位的唤醒器：槽位释放 / 池里新增账号 / 账号复活时逐个唤醒。 */
	waiters = /* @__PURE__ */ new Set();
	constructor(ids, options = {}) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
		this.now = options.now ?? (() => Date.now());
		this.sync(ids);
	}
	/** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
	sync(ids) {
		const wanted = new Set(ids);
		const before = this.accounts.size;
		for (const id of [...this.accounts.keys()]) if (!wanted.has(id)) this.accounts.delete(id);
		for (const id of ids) {
			if (this.accounts.has(id)) continue;
			this.accounts.set(id, {
				id,
				activeConcurrent: 0,
				maxConcurrent: this.maxConcurrent,
				coolUntil: 0,
				disabled: false,
				lastUsed: 0,
				errorCount: 0
			});
		}
		if (this.accounts.size !== before) this.notifyWaiters();
	}
	list() {
		return [...this.accounts.values()];
	}
	get(id) {
		return this.accounts.get(id);
	}
	/** 账号本身可用（没被禁用、不在冷却中）。 */
	healthy(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return false;
		return !account.disabled && this.now() >= account.coolUntil;
	}
	/** 现在就能接活的账号：置顶优先，其余按「最久未用」。 */
	available(exclude) {
		const now = this.now();
		return this.list().filter((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && !exclude.has(account.id) && account.activeConcurrent < account.maxConcurrent).sort((a, b) => {
			const pinned = Number(this.preferred.has(b.id)) - Number(this.preferred.has(a.id));
			return pinned !== 0 ? pinned : a.lastUsed - b.lastUsed;
		});
	}
	/** 设置暂停集合（账号 id）。 */
	setPaused(ids) {
		this.paused.clear();
		for (const id of ids) this.paused.add(id);
		this.notifyWaiters();
	}
	pausedIds() {
		return [...this.paused];
	}
	/** 设置置顶集合（账号 id）。置顶只在「同时可用」时改变先后，不绕过冷却/上限。 */
	setPreferred(ids) {
		this.preferred.clear();
		for (const id of ids) this.preferred.add(id);
	}
	preferredIds() {
		return [...this.preferred];
	}
	/** 选一个账号（跳过 `exclude` 里的）。 */
	pick(exclude = /* @__PURE__ */ new Set()) {
		return this.available(exclude)[0]?.id;
	}
	/** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
	acquire(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return false;
		if (account.activeConcurrent >= account.maxConcurrent) return false;
		account.activeConcurrent += 1;
		account.lastUsed = this.now();
		return true;
	}
	/** 释放槽位；重复释放不会把计数压到负数。 */
	release(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		if (account.activeConcurrent > 0) account.activeConcurrent -= 1;
		this.notifyWaiters();
	}
	notifyWaiters() {
		for (const waiter of [...this.waiters]) try {
			waiter();
		} catch {}
	}
	/** 现在是否有一个真正能接活的空槽位。 */
	hasFreeSlot() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && account.activeConcurrent < account.maxConcurrent);
	}
	/** 有没有「健康、但本地槽位被占满」的号 —— 只有这种值得等一会儿。 */
	hasBusyWaitable() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && !this.paused.has(account.id) && now >= account.coolUntil && account.activeConcurrent >= account.maxConcurrent);
	}
	/** 等一个本地槽位空出来，最多 `maxWaitMs`。 */
	waitForFreeSlot(maxWaitMs, signal) {
		if (this.hasFreeSlot()) return Promise.resolve(true);
		if (!this.hasBusyWaitable() || maxWaitMs <= 0) return Promise.resolve(false);
		if (signal?.aborted === true) return Promise.resolve(false);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				this.waiters.delete(check);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const check = () => {
				if (this.hasFreeSlot()) finish(true);
			};
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), maxWaitMs);
			timer.unref?.();
			this.waiters.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	/** 凭据失效等硬错误：直接停用，等用户重新登录。 */
	disable(id, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.disabled = true;
		account.lastError = reason;
	}
	/** 用户重新登录后调用：把账号从禁用/冷却里捞出来。 */
	revive(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.disabled = false;
		account.coolUntil = 0;
		account.errorCount = 0;
		account.lastError = void 0;
		this.notifyWaiters();
	}
	/** 上游 5xx / 软限流：短时冷却。 */
	cooldown(id, ms, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.coolUntil = this.now() + ms;
		account.lastError = reason;
	}
	/** 累计错误；达到阈值就冷却。 */
	noteError(id, threshold, cooldownMs, reason) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.errorCount += 1;
		account.lastError = reason;
		if (threshold > 0 && account.errorCount >= threshold) account.coolUntil = this.now() + cooldownMs;
	}
	/** 一次成功：清掉错误计数与冷却。 */
	noteSuccess(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		account.errorCount = 0;
		account.coolUntil = 0;
		account.lastError = void 0;
	}
	/** 有没有任何账号可用（含被暂停之外的）。 */
	hasUsable() {
		const now = this.now();
		return this.list().some((account) => !account.disabled && now >= account.coolUntil);
	}
};
// src/catalog.ts
/**
* DevEco 模型目录。
*
* **目录只放上游给的东西。** 唯一来源是动态发现（`discovery.ts` → `codeGenie/modelConfig`）：
* 启动时、每小时、以及卡片上「刷新模型」各拉一次，取所有成功账号的并集。
* 上游没返回的模型就是没有，未登录时目录为空 —— 不拿一份历史名单冒充「可用模型」。
*
* `FALLBACK_PARAMS` 因此**不往目录里塞模型**，只是一张按上游 id 的参数表，给发现到的
* 模型补 `contextWindow` / `maxTokens` / 视觉能力。上游有时不给这些字段，而写错的
* `maxTokens` 会让每个请求直接失败。
*
* @module dsh-deveco/catalog
*/
/**
* 参数表（**不是**模型名单）。
*
* 只给**发现到的**模型补参数，绝不会因为这里有条目就把模型塞进目录。
*/
const FALLBACK_PARAMS = [
	{
		id: "GLM-5.1-DevEco",
		wireId: "GLM-5.1",
		name: "GLM-5.1-DevEco",
		contextWindow: 17e4,
		contextWindowKnown: true,
		maxTokens: 32e3,
		supportsImages: false,
		reasoning: true,
		toolCall: true
	},
	{
		id: "GLM-5.3-DevEco",
		wireId: "GLM-5.3",
		name: "GLM-5.3-DevEco",
		contextWindow: 17e4,
		contextWindowKnown: true,
		maxTokens: 32e3,
		supportsImages: false,
		reasoning: true,
		toolCall: true,
		thinking: {
			levels: [
				"low",
				"high",
				"max"
			],
			default: "high"
		}
	},
	{
		id: DEFAULT_VISION_MODEL,
		wireId: DEFAULT_VISION_MODEL,
		name: "Qwen3.5 397B (视觉)",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: true
	},
	{
		id: "glm-5.2",
		wireId: "glm-5.2",
		name: "glm-5.2",
		contextWindow: 202752,
		contextWindowKnown: true,
		maxTokens: DEVECO_OUTPUT_CEILING,
		supportsImages: false
	},
	{
		id: "deepseek-v4.1-flash-1017",
		wireId: "deepseek-v4.1-flash-1017",
		name: "deepseek-v4.1-flash-1017",
		contextWindow: 1048576,
		contextWindowKnown: true,
		maxTokens: DEVECO_OUTPUT_CEILING,
		supportsImages: true
	}
];
/** 隐藏模型：上游目录里没有，但确实能调。 */
const HIDDEN_MODELS = HIDDEN_MODEL_IDS.map((id) => ({
	id,
	wireId: id,
	name: `${id}（隐藏）`,
	contextWindow: 1044480,
	contextWindowKnown: true,
	maxTokens: 32e3,
	supportsImages: false,
	hidden: true
}));
/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
var DevecoCatalog = class {
	/** 空目录起步：没发现过就是没有模型。 */
	models = [];
	current() {
		return this.models;
	}
	set(models) {
		this.models = [...models];
	}
	/** 按对外 id 或上游 id 找一条（大小写不敏感）。 */
	find(id) {
		const key = id.trim().toLowerCase();
		const wire = upstreamModelId(id).toLowerCase();
		return this.models.find((model) => model.id.toLowerCase() === key || model.wireId.toLowerCase() === wire);
	}
};
/** 把目录收窄到用户勾选的子集（空/缺省 = 全给）。 */
function filterEnabledModels(models, enabled) {
	if (enabled === void 0 || enabled.length === 0) return models;
	const allow = new Set(enabled.map((id) => id.trim().toLowerCase()));
	const kept = models.filter((model) => allow.has(model.id.toLowerCase()) || allow.has(model.wireId.toLowerCase()));
	return kept.length === 0 ? models : kept;
}
/**
* 合并多路来源（多账号）的模型清单。
*
* 规则：
*  - 按上游 id 去重（上游注册名大小写敏感，但同一模型书写可能不一致）；
*  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
*  - 输出按对外 id 排序，保证刷新前后顺序稳定。
*/
function mergeModelLists(sets) {
	const merged = /* @__PURE__ */ new Map();
	for (const set of sets) for (const model of set) {
		const wireId = model.wireId.trim();
		if (wireId === "") continue;
		const key = wireId.toLowerCase();
		const normalized = {
			...model,
			wireId,
			id: model.id.trim() || exposedModelId(wireId)
		};
		const current = merged.get(key);
		merged.set(key, current === void 0 ? normalized : richerModel(current, normalized));
	}
	return [...merged.values()].sort((a, b) => a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1);
}
function richerModel(current, next) {
	const keep = richerThan(next, current) ? next : current;
	const drop = keep === next ? current : next;
	const merged = {
		...keep,
		contextWindow: keep.contextWindowKnown === true || drop.contextWindowKnown !== true ? keep.contextWindow : drop.contextWindow,
		maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
		supportsImages: keep.supportsImages || drop.supportsImages,
		...drop.reasoning === true || keep.reasoning === true ? { reasoning: true } : {},
		...drop.toolCall === true || keep.toolCall === true ? { toolCall: true } : {},
		...keep.thinking === void 0 && drop.thinking === void 0 ? {} : { thinking: keep.thinking ?? drop.thinking }
	};
	if (keep.contextWindowKnown !== true) delete merged.contextWindowKnown;
	return merged;
}
function richerThan(a, b) {
	const aKnown = a.contextWindowKnown === true;
	if (aKnown !== (b.contextWindowKnown === true)) return aKnown;
	if (a.contextWindow > 0 !== b.contextWindow > 0) return a.contextWindow > 0;
	if (a.maxTokens > 0 !== b.maxTokens > 0) return a.maxTokens > 0;
	return a.supportsImages && !b.supportsImages;
}
/**
* 用参数表给**发现结果**补 0 值字段。
*
* 顺序必须是「先合并发现结果 → 再补参数」：反过来会让参数表里的占位值压过上游真值。
*/
function backfillParams(discovered, params = FALLBACK_PARAMS) {
	return discovered.map((model) => {
		const fallback = params.find((entry) => entry.wireId.toLowerCase() === model.wireId.toLowerCase());
		if (fallback === void 0) return model;
		const channel = channelLimitsFor(model.wireId);
		return {
			...model,
			name: model.name === "" || model.name === model.wireId ? fallback.name : model.name,
			contextWindow: model.contextWindowKnown === true && model.contextWindow > 0 ? model.contextWindow : channel?.context ?? fallback.contextWindow,
			contextWindowKnown: model.contextWindowKnown === true || channel !== void 0 || fallback.contextWindowKnown === true,
			maxTokens: model.maxTokens > 0 ? model.maxTokens : channel?.output ?? fallback.maxTokens,
			supportsImages: model.supportsImages || fallback.supportsImages,
			...model.reasoning === void 0 && fallback.reasoning === true ? { reasoning: true } : {},
			...model.toolCall === void 0 && fallback.toolCall === true ? { toolCall: true } : {},
			...model.thinking === void 0 && fallback.thinking !== void 0 ? { thinking: fallback.thinking } : {}
		};
	});
}
// src/discovery.ts
/**
* 动态模型发现：`GET /codeGenie/modelConfig`。
*
* 上游按**账号**下发模型目录，所以多账号要逐号拉一次再取并集 —— 一个号失败不影响
* 其它号。结果是「真实可用模型」的唯一来源：目录空就是空，不拿静态名单糊上去。
*
* 响应结构（实测，见 `docs/PROTOCOL.md`）：
*
* ```jsonc
* { "code": 200,
*   "body": { "inner_models": [ { "group_name": "GLM",
*     "task_default_model_map": { "small_model": "GLM-5.1", "blacklist": "Qwen3_5_..." },
*     "model_configs": [ { "model_id": "GLM-5.3", "thinking_mode": "on",
*       "input_modalities": ["text"], "context_window": 170000, "output": "32000",
*       "tool_call_mode": "tool_calls",
*       "reasoning_effort": "{\"level\":[\"low\",\"high\",\"max\"],\"default\":\"high\"}" } ] } ] } }
* ```
*
* @module dsh-deveco/discovery
*/
const ALLOWED_MODALITIES = /* @__PURE__ */ new Set([
	"text",
	"audio",
	"image",
	"video",
	"pdf"
]);
function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}
/**
* 解析上游的窗口 / 输出上限，**带 K/M 单位**。
*
* 实测上游两种写法都会出现：
*  - 纯数字：`context_window: 170000`（就是 tokens）；
*  - 带单位字符串：`context_window: "1024K"`、`output: "32K"`。
*
* 以前只用 `parseInt`，`"1024K"` 会被截成 **1024**、`"198K"` 截成 **198** —— 于是模型在
* DSH 里成了「上下文 198 token」的废模型（选择器里基本不可用），而且从数据上完全看不出
* 是解析错，只会以为上游给了个怪值。
*/
function parseTokenCount(value) {
	let amount;
	let multiplier = 1;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) amount = value;
	else if (typeof value === "string") {
		const match = /^\s*([\d][\d_,.]*)\s*([kKmM])?/.exec(value);
		if (match === null) return void 0;
		const parsed = Number.parseFloat((match[1] ?? "").replace(/[_,]/g, ""));
		if (!Number.isFinite(parsed) || parsed <= 0) return void 0;
		amount = parsed;
		const suffix = (match[2] ?? "").toLowerCase();
		if (suffix === "k") multiplier = 1024;
		else if (suffix === "m") multiplier = 1048576;
	}
	if (amount === void 0) return void 0;
	return Math.max(1, Math.floor(amount * multiplier));
}
/**
* 解析上游的 `reasoning_effort`：可能是 `{"level":[...],"default":"..."}` 的 JSON 文本，
* 也可能是更老的纯数组。解析不出来就当「没声明档位」。
*/
function parseReasoningEfforts(raw) {
	if (typeof raw !== "string" || raw.trim() === "") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (Array.isArray(parsed)) {
		const levels = stringList(parsed);
		return levels.length === 0 ? void 0 : { levels };
	}
	if (typedObject(parsed) === void 0) return void 0;
	const value = typedObject(parsed);
	const levels = stringList(value.level);
	if (levels.length === 0) return void 0;
	const fallback = typeof value.default === "string" && levels.includes(value.default) ? value.default : void 0;
	return fallback === void 0 ? { levels } : {
		levels,
		default: fallback
	};
}
function typedObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/**
* 明显是「千 token 单位」的窗口值下限。
*
* 上游有两种写法（见 `parseTokenCount`）：带 `K` 后缀的会被换算，**但实测也遇到过不带后缀
* 的小整数**（`context_window: 1024`、`198`），那显然不是 1024 个 token —— 真实值应是
* 1024K / 198K。没有后缀就无法从字面区分，所以用「小于 4096」当判据：没有任何在用的对话
* 模型会声明这么小的窗口，而换算后正好落在合理区间（1M / 198K）。
*/
const SUSPICIOUS_SMALL_WINDOW = 4096;
/** 输出上限的同类判据（`output: 32` 显然指 32K）。 */
const SUSPICIOUS_SMALL_OUTPUT = 512;
/** 把「看起来是 K 单位」的值还原成 tokens。 */
function expandSuspiciousCount(value, floor) {
	if (value === void 0) return void 0;
	return value < floor ? value * 1024 : value;
}
/** 一条 `model_configs` 条目 → 目录项；无法识别时 undefined。 */
function toModelInfo(entry) {
	const wireId = typeof entry.model_id === "string" ? entry.model_id.trim() : "";
	if (wireId === "") return void 0;
	const windows = expandSuspiciousCount(parseTokenCount(entry.context_window), SUSPICIOUS_SMALL_WINDOW);
	const maxTokens = expandSuspiciousCount(parseTokenCount(entry.output), SUSPICIOUS_SMALL_OUTPUT);
	const modalities = stringList(entry.input_modalities).filter((item) => ALLOWED_MODALITIES.has(item));
	const info = {
		id: exposedModelId(wireId),
		wireId,
		name: exposedModelId(wireId),
		contextWindow: windows ?? 0,
		maxTokens: maxTokens ?? 0,
		supportsImages: modalities.includes("image")
	};
	if (windows !== void 0) info.contextWindowKnown = true;
	if (entry.thinking_mode === "on") info.reasoning = true;
	if (entry.tool_call_mode === "tool_calls") info.toolCall = true;
	const thinking = parseReasoningEfforts(entry.reasoning_effort);
	if (thinking !== void 0) info.thinking = thinking;
	return info;
}
/** 解析整个 `modelConfig` 响应。 */
function parseModelConfig(raw) {
	const inner = typedObject(typedObject(raw)?.body)?.inner_models;
	const groups = Array.isArray(inner) ? inner : [];
	const models = [];
	const blacklist = [];
	let smallModel;
	for (const rawGroup of groups) {
		const group = typedObject(rawGroup);
		if (group === void 0) continue;
		const taskMap = typedObject(group.task_default_model_map);
		if (smallModel === void 0 && typeof taskMap?.small_model === "string" && taskMap.small_model !== "") smallModel = taskMap.small_model;
		if (typeof taskMap?.blacklist === "string") for (const id of taskMap.blacklist.split(",").map((item) => item.trim()).filter((item) => item !== "")) blacklist.push(id);
		const entries = group.model_configs;
		if (!Array.isArray(entries)) continue;
		for (const rawEntry of entries) {
			const entry = typedObject(rawEntry);
			if (entry === void 0) continue;
			const info = toModelInfo(entry);
			if (info !== void 0) models.push(info);
		}
	}
	const blocked = new Set(blacklist.map((id) => id.toLowerCase()));
	return {
		models: models.filter((model) => !blocked.has(model.wireId.toLowerCase())),
		...smallModel === void 0 ? {} : { smallModel },
		blacklist
	};
}
/** 单次 modelConfig 的预算。实测上游偶尔要 10s 以上才回，8s 太紧（会误判成网络故障）。 */
const MODEL_CONFIG_TIMEOUT_MS = 2e4;
/** 失败重试次数（网络抖动/超时；鉴权失败不重试）。 */
const MODEL_CONFIG_RETRIES = 1;
/**
* 拉一个账号的模型目录。
*
* 上游这个接口很不稳定：同一时刻会回 200 空列表、`errorCode: 4016`、或者十几秒才响应。
* 一旦失败，宿主的模型选择器就可能是空的 —— 所以这里带一次重试，并把超时放宽到 20s。
*/
async function fetchModelConfig(accessToken, signal) {
	let lastError;
	for (let attempt = 0; attempt <= MODEL_CONFIG_RETRIES; attempt += 1) try {
		return await fetchModelConfigOnce(accessToken, signal);
	} catch (error) {
		lastError = error;
		const message = error instanceof Error ? error.message : String(error);
		if (/401|403|4016|invalid accessToken/i.test(message)) break;
		if (signal?.aborted === true) break;
		if (attempt < MODEL_CONFIG_RETRIES) await new Promise((resolve) => {
			setTimeout(resolve, 800).unref?.();
		});
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
async function fetchModelConfigOnce(accessToken, signal) {
	const url = `${DEVECO_MODEL_CONFIG_URL}?localVersion=0&pluginVersion=${encodeURIComponent(DEVECO_CLIENT_TAG)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_CONFIG_TIMEOUT_MS);
	timer.unref?.();
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json"
			},
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`modelConfig returned HTTP ${response.status}`);
		const body = await response.json();
		const errorCode = typedObject(body)?.errorCode;
		if (typeof errorCode === "number" && errorCode !== 0) {
			const errorMsg = typedObject(body)?.errorMsg;
			throw new Error(`modelConfig returned errorCode ${errorCode}${typeof errorMsg === "string" ? `: ${errorMsg}` : ""}`);
		}
		const code = typedObject(body)?.code;
		if (code !== void 0 && code !== 200) throw new Error(`modelConfig returned code ${String(code)}`);
		const parsed = parseModelConfig(body);
		if (parsed.models.length === 0) throw new Error("modelConfig listed no usable model");
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}
/**
* 逐号发现并合并。
*
* 隐藏模型（`deepseek-v4-flash`）不在上游目录里，单独补在最后 —— 它的窗口和普通模型
* 完全不同（1M），也不该被合并规则跟别的模型混在一起。
*/
async function discoverModels(store, signal) {
	const ids = await store.dispatchIds();
	const perAccount = [];
	const sets = [];
	for (const id of ids) try {
		const resolved = await store.resolve(id);
		if (resolved === void 0) {
			perAccount.push({
				id,
				models: 0,
				errors: ["no usable credential"]
			});
			continue;
		}
		const models = backfillParams((await fetchModelConfig(resolved.accessToken, signal)).models);
		sets.push([...models]);
		perAccount.push({
			id,
			models: models.length,
			errors: []
		});
	} catch (error) {
		perAccount.push({
			id,
			models: 0,
			errors: [error instanceof Error ? error.message : String(error)]
		});
	}
	const merged = mergeModelLists(sets);
	return {
		models: [...merged, ...HIDDEN_MODELS.filter((model) => !merged.some((entry) => entry.wireId.toLowerCase() === model.wireId.toLowerCase()))],
		anySucceeded: sets.some((set) => set.length > 0),
		accounts: perAccount
	};
}
/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
async function refreshCatalog(store, catalog, signal) {
	const outcome = await discoverModels(store, signal);
	if (outcome.anySucceeded && outcome.models.length > 0) catalog.set(outcome.models);
	return outcome;
}
/** 当前配置的重置整点（0–23）。 */
function quotaResetHour() {
	const hour = envNumber("DEVECO_QUOTA_RESET_HOUR", 8);
	return hour >= 0 && hour <= 23 ? Math.floor(hour) : 8;
}
function pad(value) {
	return String(value).padStart(2, "0");
}
/**
* 算出 `now` 落在哪个额度窗口里。
*
* 边界处理：今天还没到重置时刻（例如 07:59）时，当前窗口是「昨天 08:00 开始」的那个，
* 而不是「今天 08:00」—— 否则每天开盘前都会把窗口算到未来去。
*/
function quotaWindow(now = Date.now(), resetHour = quotaResetHour()) {
	const date = new Date(now);
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), resetHour, 0, 0, 0);
	if (start.getTime() > now) start.setDate(start.getDate() - 1);
	const end = new Date(start.getTime());
	end.setDate(end.getDate() + 1);
	const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
	const label = `${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(resetHour)}:00 → ${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(resetHour)}:00`;
	return {
		key,
		start: start.getTime(),
		end: end.getTime(),
		label
	};
}
/** 当前额度窗口的键（用量台账按它分桶）。 */
function quotaWindowKey(now = Date.now()) {
	return quotaWindow(now).key;
}
/** 距离重置还剩多久，`13小时47分` 这种写法。 */
function formatQuotaRemaining(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "即将重置";
	const totalMinutes = Math.floor(ms / 6e4);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor(totalMinutes % 1440 / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
	if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
	if (minutes > 0) return `${minutes} 分`;
	return "不到 1 分钟";
}
/**
* 判断一次上游失败是不是「本周期免费额度用尽」。
*
* 实测原文（2026-11-15，403）：
* `You have used up your free quota for the current cycle (used 100027684 tokens).
*  Your quota will automatically reset at 2026-11-16 00:00:00.`
*
* 与「过载」区分：上游服务过载会回 `ModelServiceError` / `Built-in model service is
* currently overloaded` / `Full inference timed out` —— 那是**别人**把机器占满了，
* 不是你的额度没了，不该记成额度用尽，也不该就此停下。
*/
function looksLikeQuotaExhausted(status, message) {
	const text = message.toLowerCase();
	if (/overloaded|full inference timed out|service is currently overloaded/.test(text)) return false;
	if (/used up\b.*\bquota/.test(text)) return true;
	if (/\bquota\b.*\breset/.test(text)) return true;
	if (/freeusagelimiterror|free usage|insufficient_quota|usage_not_included|quota exceeded/.test(text)) return true;
	if (/额度|配额/.test(message)) return true;
	if (status === 403 && /userratelimit|rate limit|too many requests|rate increased too quickly/.test(text)) return true;
	if (status === 429) return true;
	return false;
}
/**
* 从「额度用尽」的原文里取出**重置时间**（epoch ms）。拿不到就返回 undefined。
*
* 实测格式：`Your quota will automatically reset at 2026-11-16 00:00:00.`
* 时区按本地时间理解（上游用的是北京时间）。
*/
function parseQuotaResetAt(message, now = Date.now()) {
	const match = /reset\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i.exec(message);
	if (match === null) return void 0;
	const [, year, month, day, hour, minute, second] = match;
	const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
	if (!Number.isFinite(at)) return void 0;
	if (at < now - 2592e6 || at > now + 3456e7) return void 0;
	return at;
}
/**
* 记录「谁的额度用尽了」。
*
* 只活在内存里：窗口一换所有状态作废，重启后重新学习。刻意不落盘 —— 一个过期状态被
* 当成事实显示在卡片上，比「暂时不知道」更糟。
*/
var DevecoQuotaTracker = class {
	states = /* @__PURE__ */ new Map();
	now;
	constructor(options = {}) {
		this.now = options.now ?? (() => Date.now());
	}
	/** 上游判了这个账号本窗口的额度用尽。 */
	noteExhausted(id, message) {
		const window = quotaWindowKey(this.now());
		const resetAt = parseQuotaResetAt(message, this.now());
		this.states.set(id, {
			id,
			window,
			exhausted: true,
			at: this.now(),
			...message === "" ? {} : { message: message.length > 300 ? `${message.slice(0, 300)}…` : message },
			...resetAt === void 0 ? {} : { resetAt }
		});
	}
	/** 一次成功 = 这个号本窗口没被卡住（同时把过期的「用尽」清掉）。 */
	noteOk(id) {
		const window = quotaWindowKey(this.now());
		const current = this.states.get(id);
		if (current === void 0) return;
		if (current.window !== window || current.exhausted) this.states.delete(id);
	}
	/** 某账号本窗口的状态（跨窗口的旧记录视为没有）。 */
	state(id) {
		const window = quotaWindowKey(this.now());
		const current = this.states.get(id);
		if (current === void 0) return void 0;
		if (current.window !== window) {
			this.states.delete(id);
			return;
		}
		return current;
	}
	/** 快照（`ids` 用于计算「有哪些号被挡过」，顺序稳定）。 */
	snapshot(ids, now = this.now()) {
		const window = quotaWindow(now);
		const accounts = {};
		const exhausted = [];
		for (const id of ids) {
			const state = this.state(id);
			if (state === void 0) continue;
			accounts[id] = state;
			if (state.exhausted) exhausted.push(id);
		}
		const untils = exhausted.map((id) => accounts[id]?.resetAt).filter((value) => typeof value === "number" && value > now);
		return {
			window,
			resetInMs: Math.max(0, window.end - now),
			resetIn: formatQuotaRemaining(window.end - now),
			exhausted,
			...untils.length === 0 ? {} : { exhaustedUntil: Math.min(...untils) },
			accounts,
			hasUpstreamEndpoint: false
		};
	}
};
// src/usage.ts
/**
* 本机用量台账。
*
* 只记**本机经这个插件发出去的**请求：上游不提供用量接口（见 `docs/PROTOCOL.md` 第 6 节），
* 所以「今天用了多少」只能自己攒。它是估算的、不完整的（其它设备/IDE 的用量不在里面），
* 卡片上必须这么标，不能写成「账号总额度」。
*
* 口径：
*  - `requests` 发出去的生成请求数（含失败）；
*  - `inputTokens` / `outputTokens` 来自上游响应体里的 `usage`（流式取最后一个带的块）；
*  - `today` 按**额度窗口**归零（上游每天在固定整点重置免费额度，不是自然日零点，
*    见 `quota.ts`），同时保留 `totals` 全量。
*
* @module dsh-deveco/usage
*/
const EMPTY_TOTALS = {
	requests: 0,
	failures: 0,
	inputTokens: 0,
	outputTokens: 0
};
/**
* 本地**自然日**键 `YYYY-MM-DD`。
*
* 只给签到台账用（签到是人的习惯，按自然日数连续天数）。用量分桶走
* `quotaWindowKey()`，因为上游的免费额度是按固定整点重置的。
*/
function localDayKey(at = Date.now()) {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
function addTotals(target, event) {
	return {
		requests: target.requests + 1,
		failures: target.failures + (event.ok ? 0 : 1),
		inputTokens: target.inputTokens + (event.inputTokens ?? 0),
		outputTokens: target.outputTokens + (event.outputTokens ?? 0)
	};
}
var DevecoUsageTracker = class {
	path;
	document = {
		version: 1,
		scope: "local",
		day: quotaWindowKey(),
		totals: { ...EMPTY_TOTALS },
		today: { ...EMPTY_TOTALS },
		byAccount: {},
		byModel: {},
		recent: [],
		updatedAt: Date.now()
	};
	loaded = false;
	flushTimer;
	constructor(options) {
		this.path = options.path;
	}
	/** 读盘。失败/文件缺失都不影响插件启动。 */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return;
			this.document = {
				version: 1,
				scope: "local",
				day: typeof parsed.day === "string" ? parsed.day : quotaWindowKey(),
				totals: normalizeTotals(parsed.totals),
				today: normalizeTotals(parsed.today),
				byAccount: normalizeBuckets(parsed.byAccount),
				byModel: normalizeBuckets(parsed.byModel),
				recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-100) : [],
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now()
			};
			this.rollDay();
		} catch {}
	}
	/** 记一次请求。 */
	record(event) {
		const at = event.at ?? Date.now();
		this.rollDay();
		const full = {
			at,
			account: event.account,
			model: event.model,
			ok: event.ok,
			ms: event.ms,
			...event.inputTokens === void 0 ? {} : { inputTokens: event.inputTokens },
			...event.outputTokens === void 0 ? {} : { outputTokens: event.outputTokens }
		};
		this.document.totals = addTotals(this.document.totals, full);
		this.document.today = addTotals(this.document.today, full);
		this.document.byAccount[full.account] = addTotals(this.document.byAccount[full.account] ?? { ...EMPTY_TOTALS }, full);
		this.document.byModel[full.model] = addTotals(this.document.byModel[full.model] ?? { ...EMPTY_TOTALS }, full);
		this.document.recent = [...this.document.recent.slice(-99), full];
		this.document.updatedAt = at;
		this.scheduleFlush();
	}
	/** 立刻落盘（插件停用时调）。 */
	async flush() {
		if (this.flushTimer !== void 0) {
			clearTimeout(this.flushTimer);
			this.flushTimer = void 0;
		}
		const dir = dirname(this.path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.document, void 0, 2)}\n`, "utf8");
		renameSync(temp, this.path);
	}
	/** 当前快照。 */
	snapshot() {
		this.rollDay();
		return {
			scope: "local",
			day: this.document.day,
			totals: { ...this.document.totals },
			today: { ...this.document.today },
			byAccount: { ...this.document.byAccount },
			byModel: { ...this.document.byModel },
			recent: [...this.document.recent].reverse()
		};
	}
	scheduleFlush() {
		if (this.flushTimer !== void 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = void 0;
			this.flush().catch(() => {});
		}, 2e3);
		this.flushTimer.unref?.();
	}
	/** 跨天把 `today` 归零（`totals` 保留）。 */
	rollDay() {
		const day = quotaWindowKey();
		if (day === this.document.day) return;
		this.document.day = day;
		this.document.today = { ...EMPTY_TOTALS };
	}
};
function normalizeTotals(value) {
	if (typeof value !== "object" || value === null) return { ...EMPTY_TOTALS };
	const raw = value;
	return {
		requests: numberOr0(raw.requests),
		failures: numberOr0(raw.failures),
		inputTokens: numberOr0(raw.inputTokens),
		outputTokens: numberOr0(raw.outputTokens)
	};
}
function normalizeBuckets(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) out[key] = normalizeTotals(entry);
	return out;
}
function numberOr0(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
// src/checkin.ts
/**
* 每日签到。
*
* **先说清楚上游事实**：DevEco（CodeGenie MaaS）没有任何积分/福利/领取接口，也**不需要**
* 「领」—— 免费额度按自然日自动重置（每日 08:00 左右，实测）。opencode-deveco 与
* deveco-code 两个仓库里都不存在签到/领取/积分/quota 端点（见 `docs/PROTOCOL.md` 第 6 节）。
*
* 所以这个插件里的「签到」是一件事**真能做到**的事，而不是伪造一次领取：
*
* 1. 对每个账号发一次轻量但**需要鉴权**的请求（`modelConfig`）——它同时证明
*    「凭证今天还有效」和「模型目录今天能拿到」；
* 2. 把结果按自然日留档，算出连续签到天数；
* 3. 签到失败（凭证被拒）会立刻把账号标成 stale，让卡片直接给出「重新登录」。
*
* 换言之：这是一次**每天一次的账号体检**，不是一个虚假的奖励按钮。卡片上也是这么写的。
*
* @module dsh-deveco/checkin
*/
/** 台账保留天数。 */
const KEEP_DAYS = 90;
/** 按本地自然日倒推的日期键（`offset` 天前）。 */
function dayKeyOffset(offset, now = Date.now()) {
	return localDayKey(now - offset * 24 * 60 * 60 * 1e3);
}
var DevecoCheckinLedger = class {
	path;
	document = {
		version: 1,
		days: {}
	};
	loaded = false;
	constructor(options) {
		this.path = options.path;
	}
	ensureLoaded() {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			const days = {};
			for (const [day, value] of Object.entries(parsed.days ?? {})) {
				if (typeof value !== "object" || value === null) continue;
				const records = {};
				for (const [id, record] of Object.entries(value)) {
					if (typeof record !== "object" || record === null) continue;
					const raw = record;
					records[id] = {
						at: typeof raw.at === "number" ? raw.at : 0,
						ok: raw.ok === true,
						models: typeof raw.models === "number" ? raw.models : 0,
						...typeof raw.message === "string" ? { message: raw.message } : {}
					};
				}
				days[day] = records;
			}
			this.document = {
				version: 1,
				days: this.prune(days)
			};
		} catch {}
	}
	prune(days) {
		const keys = Object.keys(days).sort();
		if (keys.length <= KEEP_DAYS) return days;
		const keep = new Set(keys.slice(-90));
		const out = {};
		for (const key of keys) if (keep.has(key)) out[key] = days[key];
		return out;
	}
	flush() {
		const dir = dirname(this.path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.document, void 0, 2)}\n`, "utf8");
		renameSync(temp, this.path);
	}
	/** 某账号今天的记录。 */
	todayRecord(accountId, now = Date.now()) {
		this.ensureLoaded();
		return this.document.days[localDayKey(now)]?.[accountId];
	}
	/** 写入一条记录（同一天同账号覆盖）。 */
	record(accountId, record, now = Date.now()) {
		this.ensureLoaded();
		const day = localDayKey(now);
		const bucket = this.document.days[day] ?? {};
		bucket[accountId] = record;
		this.document.days[day] = bucket;
		this.document.days = this.prune(this.document.days);
		this.flush();
	}
	/**
	* 连续签到天数：从今天往回数，**只要当天有成功记录**就继续。
	*
	* 今天还没签时从昨天开始数（这样「今天还没签」不会把连续天数显示成 0）。
	*/
	streak(accountId, now = Date.now()) {
		this.ensureLoaded();
		const today = localDayKey(now);
		let offset = this.document.days[today]?.[accountId]?.ok === true ? 0 : 1;
		let streak = 0;
		while (offset < KEEP_DAYS) {
			const key = dayKeyOffset(offset, now);
			if ((this.document.days[key]?.[accountId])?.ok !== true) break;
			streak += 1;
			offset += 1;
		}
		return streak;
	}
	/** 台账快照。 */
	snapshot(accountIds, now = Date.now()) {
		this.ensureLoaded();
		const day = localDayKey(now);
		const streaks = {};
		for (const id of accountIds) streaks[id] = this.streak(id, now);
		const days = Object.keys(this.document.days).filter((key) => Object.values(this.document.days[key] ?? {}).some((record) => record.ok)).sort((a, b) => a < b ? 1 : -1).slice(0, 30);
		return {
			day,
			today: { ...this.document.days[day] ?? {} },
			streaks,
			days
		};
	}
};
/**
* 执行一次签到。
*
* - `accountId` 省略 = 所有账号；
* - 今天已经签过（且成功）的账号默认跳过，不重复打上游（`force: true` 可强制重签）；
* - 凭证被上游拒绝时把账号标成 stale —— 签到本来就是「这个号今天还能不能用」的体检，
*   发现问题却不在卡片上体现，那这个功能就白做了。
*/
async function runCheckin(store, ledger, options = {}) {
	const ids = options.accountId === void 0 ? await store.ids() : [options.accountId];
	const day = localDayKey();
	const results = [];
	let probed = 0;
	for (const id of ids) {
		const existing = ledger.todayRecord(id);
		if (existing?.ok === true && options.force !== true) {
			results.push({
				id,
				...existing,
				alreadyCheckedToday: true
			});
			continue;
		}
		probed += 1;
		try {
			const resolved = await store.resolve(id);
			if (resolved === void 0) {
				const record = {
					at: Date.now(),
					ok: false,
					models: 0,
					message: "account needs sign-in"
				};
				ledger.record(id, record);
				results.push({
					id,
					...record,
					alreadyCheckedToday: false
				});
				continue;
			}
			const probe = await fetchModelConfig(resolved.accessToken, options.signal).then((fetched) => ({
				ok: true,
				models: fetched.models.length,
				message: void 0
			}), (error) => ({
				ok: false,
				models: 0,
				message: error instanceof Error ? error.message : String(error)
			}));
			const record = {
				at: Date.now(),
				ok: probe.ok,
				models: probe.models,
				...probe.message === void 0 ? {} : { message: probe.message }
			};
			ledger.record(id, record);
			if (!probe.ok && probe.message !== void 0 && /unauthor|forbidden|401|403/i.test(probe.message)) await store.markRejected(id, `check-in failed: ${probe.message}`);
			results.push({
				id,
				...record,
				alreadyCheckedToday: false
			});
		} catch (error) {
			const record = {
				at: Date.now(),
				ok: false,
				models: 0,
				message: error instanceof Error ? error.message : String(error)
			};
			ledger.record(id, record);
			results.push({
				id,
				...record,
				alreadyCheckedToday: false
			});
		}
	}
	const ok = results.some((result) => result.ok);
	const claimed = results.filter((result) => result.ok && !result.alreadyCheckedToday).length;
	return {
		day,
		results,
		ok,
		probed,
		message: buildMessage(results, ok, claimed)
	};
}
function buildMessage(results, ok, checked) {
	if (results.length === 0) return "no account to check in";
	if (ok) return checked === 0 ? "already checked in today" : `checked in ${checked} account${checked === 1 ? "" : "s"}`;
	const firstError = results.find((result) => !result.ok)?.message;
	return firstError === void 0 ? "check-in failed" : `check-in failed: ${firstError}`;
}
// src/normalize.ts
/**
* OpenAI 请求体 → DevEco 能接受的形状。
*
* 上游不是「标准 OpenAI」，有六条会直接 400/403 的硬规则（`docs/PROTOCOL.md` 第 5 节）：
*
* 1. `developer` 角色不在枚举里 → 改成 `system`；
* 2. `max_completion_tokens` 被忽略 → 映射成 `max_tokens`，并按渠道上限（32K）钳住；
* 3. `tool_choice` 只收 `"auto" | "none" | "required"`，对象形式整个请求 400
*    → 指定某个工具要用 `"required"` + 收窄 `tools` 模拟；
* 4. `reasoning_effort` 只能发上游声明过的档位，未知值直接丢；
* 5. 思考内容要显式索要（`chat_template_kwargs.enable_thinking`），否则会被塞进 `content`
*    并以一个孤零零的 `</think>` 结尾 —— 前端看起来像模型在胡说；
* 6. 纯文本模型收到图片是 403，必须改路由（`vision.ts`）。
*
* 所有函数都是纯函数：给同样的输入永远是同样的输出，方便单测。
*
* @module dsh-deveco/normalize
*/
/** pi-ai 的标准档位，按由弱到强排列。 */
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* `developer` → `system`。
*
* 上游 role 枚举只有 `function|user|assistant|system|tool`；新版 OpenAI 客户端会把系统
* 提示拆成 `developer`，直接发过去整条请求 400。
*/
function normalizeDeveloperRole(body) {
	const messages = body.messages;
	if (!Array.isArray(messages)) return {
		body,
		changed: false,
		notes: []
	};
	let changed = false;
	const next = messages.map((message) => {
		if (!isPlainObject(message) || message.role !== "developer") return message;
		changed = true;
		return {
			...message,
			role: "system"
		};
	});
	if (!changed) return {
		body,
		changed: false,
		notes: []
	};
	return {
		body: {
			...body,
			messages: next
		},
		changed: true,
		notes: ["developer-role->system"]
	};
}
/**
* `max_completion_tokens` → `max_tokens`，并按渠道声明的**输出**上限钳住。
*
* 注意这是输出上限（max_tokens），不是上下文窗口。渠道对 GLM 声明 32K；没有单独声明的
* 模型统一按 `outputCeiling()` 处理。不钳会 400，钳得太小会在中途截断长回答与推理。
*/
function normalizeMaxTokens(body, model) {
	const next = { ...body };
	let changed = false;
	const completion = next.max_completion_tokens;
	delete next.max_completion_tokens;
	if (completion !== void 0) changed = true;
	if (typeof completion === "number" && next.max_tokens === void 0) next.max_tokens = completion;
	const cap = channelLimitsFor(model)?.output ?? outputCeiling();
	if (typeof next.max_tokens === "number" && next.max_tokens > cap) {
		next.max_tokens = cap;
		changed = true;
	}
	return changed ? {
		body: next,
		changed: true,
		notes: ["max-tokens-normalized"]
	} : {
		body,
		changed: false,
		notes: []
	};
}
/** 把一个工具名从 `{type:'function',function:{name}}` / `{name}` 里取出来。 */
function forcedToolName(choice) {
	const fn = choice.function;
	if (isPlainObject(fn) && typeof fn.name === "string") return fn.name;
	if (typeof choice.name === "string") return choice.name;
}
/** 只留下名字匹配的那个工具。 */
function narrowTools(tools, name) {
	if (!Array.isArray(tools)) return void 0;
	const kept = tools.filter((tool) => {
		if (!isPlainObject(tool)) return false;
		const fn = tool.function;
		if (isPlainObject(fn) && fn.name === name) return true;
		return tool.name === name;
	});
	return kept.length === 0 ? void 0 : kept;
}
/**
* `tool_choice` 只留枚举值。
*
* 对象形式（指定某个工具）在上游会 400，所以用 `"required"` + 只留那一个工具来模拟；
* 实在模拟不了就退回 `"auto"` —— 降级也绝不能让整条请求挂掉。
*/
function normalizeToolChoice(body) {
	const choice = body.tool_choice;
	if (choice === void 0) return {
		body,
		changed: false,
		notes: []
	};
	if (typeof choice === "string") {
		const value = choice.trim().toLowerCase();
		if (value === "auto" || value === "none" || value === "required") return value === choice ? {
			body,
			changed: false,
			notes: []
		} : {
			body: {
				...body,
				tool_choice: value
			},
			changed: true,
			notes: ["tool-choice-lowercased"]
		};
		const next = { ...body };
		delete next.tool_choice;
		return {
			body: next,
			changed: true,
			notes: ["tool-choice-dropped"]
		};
	}
	if (!isPlainObject(choice)) {
		const next = { ...body };
		delete next.tool_choice;
		return {
			body: next,
			changed: true,
			notes: ["tool-choice-dropped"]
		};
	}
	const type = typeof choice.type === "string" ? choice.type.toLowerCase() : "";
	if (type === "auto" || type === "none" || type === "required") return {
		body: {
			...body,
			tool_choice: type
		},
		changed: true,
		notes: ["tool-choice-unwrapped"]
	};
	const name = forcedToolName(choice);
	if (name !== void 0) {
		const narrowed = narrowTools(body.tools, name);
		if (narrowed !== void 0) return {
			body: {
				...body,
				tool_choice: "required",
				tools: narrowed
			},
			changed: true,
			notes: ["tool-choice-forced"]
		};
	}
	return {
		body: {
			...body,
			tool_choice: "auto"
		},
		changed: true,
		notes: ["tool-choice-degraded"]
	};
}
/**
* 档位吸附。
*
* 上游声明了档位的模型（GLM-5.3：`low|high|max`）只认声明值；未声明档位或声明之外的
* 值一律丢弃 —— 让上游走它自己的默认，比发一个它不认识的枚举安全。
*/
function snapEffort(value, levels) {
	if (levels.includes(value)) return value;
	const normalized = value === "off" ? "none" : value;
	if (levels.includes(normalized)) return normalized;
	const target = EFFORT_ORDER.indexOf(normalized);
	if (target === -1) return void 0;
	let best;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const level of levels) {
		const index = EFFORT_ORDER.indexOf(level);
		if (index === -1) continue;
		const distance = Math.abs(index - target);
		if (distance < bestDistance || distance === bestDistance && index > EFFORT_ORDER.indexOf(best)) {
			best = level;
			bestDistance = distance;
		}
	}
	return best;
}
/** `reasoning_effort` 归一化（含 `none`/`off` → 关闭思考）。 */
function normalizeReasoningEffort(body, ctx) {
	const effort = body.reasoning_effort;
	if (effort === void 0) return {
		body,
		changed: false,
		notes: []
	};
	if (typeof effort !== "string") {
		const next = { ...body };
		delete next.reasoning_effort;
		return {
			body: next,
			changed: true,
			notes: ["effort-dropped-non-string"]
		};
	}
	const value = effort.trim().toLowerCase();
	if (value === "") {
		const next = { ...body };
		delete next.reasoning_effort;
		return {
			body: next,
			changed: true,
			notes: ["effort-dropped-empty"]
		};
	}
	const levels = ctx.levels ?? [];
	if (levels.length > 0) {
		const snapped = snapEffort(value, levels);
		if (snapped === void 0) {
			const next = { ...body };
			delete next.reasoning_effort;
			return {
				body: next,
				changed: true,
				notes: ["effort-dropped-undeclared"]
			};
		}
		if (snapped === value) return {
			body,
			changed: false,
			notes: []
		};
		return {
			body: {
				...body,
				reasoning_effort: snapped
			},
			changed: true,
			notes: ["effort-snapped"]
		};
	}
	if (value === "none" || value === "off") {
		const next = { ...body };
		delete next.reasoning_effort;
		next.thinking = { type: "disabled" };
		return {
			body: next,
			changed: true,
			notes: ["thinking-disabled"]
		};
	}
	if (EFFORT_ORDER.includes(value)) return value === effort ? {
		body,
		changed: false,
		notes: []
	} : {
		body: {
			...body,
			reasoning_effort: value
		},
		changed: true,
		notes: ["effort-lowercased"]
	};
	const next = { ...body };
	delete next.reasoning_effort;
	return {
		body: next,
		changed: true,
		notes: ["effort-dropped-unknown"]
	};
}
/**
* 显式索要思考内容。
*
* 不索要时 GLM 会把思考写进 `content`，并以一个没有开头标签的 `</think>` 收尾 ——
* DSH 的渲染和重放都会被这段污染。索要之后上游用独立的 reasoning 字段返回。
*/
function requestThinking(body) {
	const current = body.chat_template_kwargs;
	const merged = isPlainObject(current) ? {
		...current,
		enable_thinking: true
	} : { enable_thinking: true };
	if (isPlainObject(current) && current.enable_thinking === true) return {
		body,
		changed: false,
		notes: []
	};
	return {
		body: {
			...body,
			chat_template_kwargs: merged
		},
		changed: true,
		notes: ["thinking-requested"]
	};
}
/**
* 清掉历史里内联的思考尾巴。
*
* 老会话（或别的客户端）留下的 assistant 内容可能带着 `…</think>真正的回答`。重放时
* 上游会把它当普通文本，越滚越长。只在最后一个 `</think>` 处切一刀，没有就不动。
*/
function cleanAssistantThink(body) {
	const messages = body.messages;
	if (!Array.isArray(messages)) return {
		body,
		changed: false,
		notes: []
	};
	let changed = false;
	const next = messages.map((message) => {
		if (!isPlainObject(message) || message.role !== "assistant") return message;
		const content = message.content;
		if (typeof content === "string") {
			const index = content.lastIndexOf("</think>");
			if (index === -1) return message;
			changed = true;
			const trimmed = content.slice(index + 8).trimStart();
			return {
				...message,
				content: trimmed
			};
		}
		if (!Array.isArray(content)) return message;
		let touched = false;
		const parts = content.map((part) => {
			if (!isPlainObject(part) || part.type !== "text" || typeof part.text !== "string") return part;
			const index = part.text.lastIndexOf("</think>");
			if (index === -1) return part;
			touched = true;
			return {
				...part,
				text: part.text.slice(index + 8).trimStart()
			};
		});
		if (!touched) return message;
		changed = true;
		return {
			...message,
			content: parts
		};
	});
	return changed ? {
		body: {
			...body,
			messages: next
		},
		changed: true,
		notes: ["assistant-think-trimmed"]
	} : {
		body,
		changed: false,
		notes: []
	};
}
/** 消息里有没有图片块。 */
function hasImageContent(messages) {
	if (!Array.isArray(messages)) return false;
	for (const message of messages) {
		if (!isPlainObject(message)) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) if (isPlainObject(part) && (part.type === "image_url" || part.type === "image")) return true;
	}
	return false;
}
/** 从最后一条 assistant 之后的消息里找图片（= 这一轮的新输入）。 */
function currentTurnHasImage(messages) {
	if (!Array.isArray(messages)) return false;
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isPlainObject(message) && message.role === "assistant") {
			start = index + 1;
			break;
		}
	}
	return hasImageContent(messages.slice(start));
}
/** 把历史图片换成文字占位（纯文本模型 + 只有历史里有图时）。 */
function replaceImagesWithPlaceholder(body) {
	const messages = body.messages;
	if (!Array.isArray(messages)) return {
		body,
		changed: false,
		notes: []
	};
	let changed = false;
	const next = messages.map((message) => {
		if (!isPlainObject(message)) return message;
		const content = message.content;
		if (!Array.isArray(content)) return message;
		let touched = false;
		const parts = content.map((part) => {
			if (!isPlainObject(part)) return part;
			if (part.type !== "image_url" && part.type !== "image") return part;
			touched = true;
			return {
				type: "text",
				text: "[图片]"
			};
		});
		if (!touched) return message;
		changed = true;
		return {
			...message,
			content: parts
		};
	});
	return changed ? {
		body: {
			...body,
			messages: next
		},
		changed: true,
		notes: ["images-placeholdered"]
	} : {
		body,
		changed: false,
		notes: []
	};
}
/**
* 视觉路由。
*
* 纯文本模型（`input_modalities: ['text']`）收到含图请求会 403。这一轮真有图就换视觉
* 模型，并且**必须**丢掉 `tools`/`tool_choice`：那个模型只会把工具调用当文本吐出来，
* 结构化调用根本不会发生。只有历史有图则原地换成 `[图片]` 占位，保持当前模型。
*/
function routeVision(body, ctx, currentModel) {
	if (ctx.textOnly !== true) return {
		body,
		changed: false,
		notes: []
	};
	if (currentTurnHasImage(body.messages)) {
		const next = {
			...body,
			model: ctx.visionModel ?? "Qwen3_5_397B_A17B_w8a8_single"
		};
		delete next.tools;
		delete next.tool_choice;
		return {
			body: next,
			changed: true,
			notes: ["vision-rerouted"]
		};
	}
	if (!hasImageContent(body.messages)) return {
		body,
		changed: false,
		notes: []
	};
	if (currentModel === (ctx.visionModel ?? "Qwen3_5_397B_A17B_w8a8_single")) return {
		body,
		changed: false,
		notes: []
	};
	return replaceImagesWithPlaceholder(body);
}
/** 归一化管线：顺序有意义（`tool_choice` 必须在 `tools` 收窄之后）。 */
function normalizeChatBody(body, ctx) {
	let current = body;
	const notes = [];
	const steps = [
		(input) => cleanAssistantThink(input),
		(input) => normalizeDeveloperRole(input),
		(input) => normalizeMaxTokens(input, String(input.model ?? ctx.model)),
		(input) => normalizeReasoningEffort(input, ctx),
		(input) => ctx.reasoning === true ? requestThinking(input) : {
			body: input,
			changed: false,
			notes: []
		},
		(input) => routeVision(input, ctx, String(input.model ?? ctx.model)),
		(input) => normalizeToolChoice(input)
	];
	for (const step of steps) {
		const outcome = step(current);
		if (outcome.changed) {
			current = outcome.body;
			notes.push(...outcome.notes);
		}
	}
	return {
		body: current,
		changed: notes.length > 0,
		notes
	};
}
// src/queue.ts
/**
* 上游生成的并发闸门。
*
* DevEco 对每条渠道只同时放行一个生成任务：多个请求一起打过去只会在服务端排队，
* 而服务端排队我们看不见、也没法取消。所以本地先排：同时 1 个在飞，最多 3 个等待，
* 再多就直接 429 —— 排队上限存在的意义是**别让用户以为它还在跑**。
*
* 排队入场的请求要先冷却一小会儿（默认 1s）：上游释放槽位和真正接受下一个请求之间
* 有个短暂的不一致窗口，立刻打回去经常撞到「session busy」。
*
* @module dsh-deveco/queue
*/
/** 队列满时给调用方的错误，文案对齐 opencode-deveco 的 429。 */
const QUEUE_FULL_MESSAGE = "upstream generation queue is full, please retry shortly";
var DevecoQueueGate = class {
	active = 0;
	waiters = [];
	maxConcurrent;
	maxQueue;
	cooldownMs;
	disposed = false;
	constructor(options = {}) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
		this.maxQueue = Math.max(0, options.maxQueue ?? 3);
		this.cooldownMs = Math.max(0, options.cooldownMs ?? 1e3);
	}
	/**
	* 申请一个生成位。
	*
	* @returns `true` = 拿到了，用完必须 `release()`；`false` = 队列已满（调用方回 429）。
	*/
	async acquire(signal) {
		if (this.disposed) return false;
		if (signal?.aborted === true) return false;
		if (this.active < this.maxConcurrent && this.waiters.length === 0) {
			this.active += 1;
			return true;
		}
		if (this.waiters.length >= this.maxQueue) return false;
		return await new Promise((resolve) => {
			const waiter = {
				resolve,
				granted: false
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index === -1) return;
				this.waiters.splice(index, 1);
				if (waiter.timer !== void 0) clearTimeout(waiter.timer);
				resolve(false);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const originalResolve = waiter.resolve;
			waiter.resolve = (granted) => {
				signal?.removeEventListener("abort", onAbort);
				originalResolve(granted);
			};
			this.waiters.push(waiter);
			this.pump();
		});
	}
	/** 释放一个生成位，并让队首入场。 */
	release() {
		if (this.active > 0) this.active -= 1;
		this.pump();
	}
	/** 队列里还有几个在等。 */
	queued() {
		return this.waiters.length;
	}
	snapshot() {
		return {
			active: this.active,
			queued: this.waiters.length,
			maxConcurrent: this.maxConcurrent,
			maxQueue: this.maxQueue
		};
	}
	/** 撤掉所有等待者（插件停用）。 */
	dispose() {
		this.disposed = true;
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.timer !== void 0) clearTimeout(waiter.timer);
			waiter.resolve(false);
		}
	}
	/** 有空位就把队首放进来（排队过的请求先冷却一小会儿）。 */
	pump() {
		if (this.disposed) return;
		while (this.active < this.maxConcurrent) {
			const waiter = this.waiters.shift();
			if (waiter === void 0) return;
			const grant = () => {
				if (waiter.granted) return;
				waiter.granted = true;
				this.active += 1;
				waiter.resolve(true);
			};
			if (this.cooldownMs === 0) {
				grant();
				continue;
			}
			waiter.timer = setTimeout(grant, this.cooldownMs);
			waiter.timer.unref?.();
			return;
		}
	}
};
// src/upstream.ts
/**
* 上游对话转发：请求头、路径、排队槽位释放、错误归类、用量抽取。
*
* 这一层只做「怎么跟 DevEco 说话」，不含账号选择策略（那是 `shim.ts` 的事），
* 也不碰凭证存储（那是 `auth.ts` 的事）。
*
* 三条最容易踩的上游怪癖（`docs/PROTOCOL.md` 第 4 节）：
*
* - **非流式是另一条路径**（`/no-stream/chat/completions`），不是 body 里的 `stream:false`；
* - `Session-Id` 必须 ≤ 32 字符，超了上游直接 400；
* - 服务端按 (`Session-Id`, `Chat-Id`) 维护轮次状态，每轮结束要 `POST exitSessionQueue`
*   把槽位放掉，否则会一直漏。
*
* @module dsh-deveco/upstream
*/
/** 上游 API 的 origin 与前缀。 */
const API_ORIGIN = new URL(DEVECO_API_BASE).origin;
const API_PREFIX = new URL(DEVECO_API_BASE).pathname.replace(/\/$/, "");
/** 32 位十六进制（去连字符 UUID）。 */
function newId32() {
	return randomUUID().replace(/-/g, "");
}
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/**
* 把客户端给的会话标识压成「≤32 字符、稳定」的形态。
*
* 上游要求 `Session-Id` ≤ 32 字符（超了回 `SSE request header Session-Id is too long`），
* 而客户端发来的可能是 36 位 UUID（去掉连字符正好 32），也可能是长字符串（稳定哈希）。
*/
function normalizeAffinityId(value) {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	if (UUID_PATTERN.test(trimmed)) return trimmed.replace(/-/g, "").toLowerCase();
	if (trimmed.length <= 32) return trimmed;
	return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}
/**
* 推导会话键。
*
* 用**首条 user 消息**做键，而不是 `messages[0]`：后者通常是 system prompt，里面有
* 日期、工作目录这类每次都变的内容 —— 用它做键等于每轮都新开一个上游会话，很快就
* 会撞到上游的「新会话频率」限制。
*/
function conversationKey(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const seed = messages.find((message) => isObject(message) && message.role === "user") ?? messages[0] ?? "";
	return createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 32);
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** `Chat-Id` 的缓存上限：按会话键缓存，避免无限增长。 */
const CHAT_ID_CACHE_LIMIT = 500;
const chatIdCache = /* @__PURE__ */ new Map();
/** 取（或铸造）一个会话的 `Chat-Id`。 */
function chatIdFor(sessionId) {
	const cached = chatIdCache.get(sessionId);
	if (cached !== void 0) return cached;
	if (chatIdCache.size >= CHAT_ID_CACHE_LIMIT) {
		const oldest = chatIdCache.keys().next().value;
		if (oldest !== void 0) chatIdCache.delete(oldest);
	}
	const chatId = newId32();
	chatIdCache.set(sessionId, chatId);
	return chatId;
}
/** 从入站请求头里取客户端指定的会话/任务标识。 */
function identityFromHeaders(headers, body) {
	const pick = (name) => {
		const raw = headers[name];
		const value = Array.isArray(raw) ? raw[0] : raw;
		return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
	};
	const explicit = pick("x-deveco-session") ?? pick("x-session-affinity") ?? pick("x-session-id");
	const sessionId = explicit !== void 0 ? normalizeAffinityId(explicit) : conversationKey(body);
	const taskHeader = pick("x-deveco-task");
	return {
		sessionId,
		chatId: chatIdFor(sessionId),
		taskId: taskHeader !== void 0 ? normalizeAffinityId(taskHeader) : newId32()
	};
}
/** 聊天请求头。 */
function buildChatHeaders(accessToken, identity, extra = {}) {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		lang: "en",
		"Chat-Id": identity.chatId,
		"Session-Id": identity.sessionId,
		"x-deveco-session": identity.sessionId,
		"x-deveco-task": identity.taskId,
		"x-deveco-client": DEVECO_CLIENT_TAG,
		"User-Agent": BROWSER_USER_AGENT,
		"accept-language": "zh-CN",
		"X-DevEco-Improvement-Enabled": process.env.DEVECO_TOOL_IMPROVEMENT === "1" ? "true" : "false"
	};
	if (extra.project !== void 0 && extra.project !== "") headers["x-deveco-project"] = extra.project;
	if (extra.parentSession !== void 0 && extra.parentSession !== "") headers["x-deveco-parent-session"] = normalizeAffinityId(extra.parentSession);
	return headers;
}
/** 上游聊天地址（流式/非流式是两条路径）。 */
function chatUrl(stream) {
	const path = stream ? `${API_PREFIX}/chat/completions` : `${API_PREFIX}/no-stream/chat/completions`;
	return `${API_ORIGIN}${path}`;
}
/**
* 放掉服务端的排队槽位。
*
* 必须在 `finally` 里调：上游按 (`Session-Id`, `Chat-Id`) 占槽，漏一次就是漏一个名额。
* 整体有 `EXIT_QUEUE_GRACE_MS` 上限 —— 释放失败不能把本地队列卡住。
*/
async function exitSessionQueue(accessToken, identity, model) {
	const attempt = async (retriesLeft) => {
		const url = `${DEVECO_EXIT_QUEUE_URL}?modelId=${encodeURIComponent(model)}`;
		try {
			if ((await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Session-Id": identity.sessionId,
					"Chat-Id": identity.chatId,
					"x-deveco-session": identity.sessionId,
					"x-deveco-task": identity.taskId,
					Authorization: `Bearer ${accessToken}`
				},
				signal: AbortSignal.timeout(5e3)
			})).ok) return;
			if (retriesLeft <= 0) return;
		} catch {
			if (retriesLeft <= 0) return;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 400).unref?.();
		});
		await attempt(retriesLeft - 1);
	};
	await new Promise((resolve) => {
		const timer = setTimeout(resolve, EXIT_QUEUE_GRACE_MS);
		timer.unref?.();
		attempt(1).then(() => {
			clearTimeout(timer);
			resolve();
		}, () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
/** 提示：渠道声明的上下文上限（用户看到的必须是渠道事实，不是官方规格）。 */
const CONTEXT_LIMIT_HINT = "DevEco serves GLM-5.1-DevEco / GLM-5.3-DevEco with a 170,000-token context and a 32,000-token output cap.";
/** 从响应体里抠出可读的错误文本。 */
async function readErrorText(response) {
	try {
		const text = await response.text();
		if (text === "") return `HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(text);
			if (isObject(parsed)) {
				const error = parsed.error;
				if (typeof error === "string") return error;
				if (isObject(error) && typeof error.message === "string") return error.message;
				if (typeof parsed.message === "string") return parsed.message;
				if (typeof parsed.msg === "string") return parsed.msg;
			}
		} catch {}
		return text.length > 600 ? `${text.slice(0, 600)}…` : text;
	} catch {
		return `HTTP ${response.status}`;
	}
}
/** 归类一次上游失败。 */
function classifyUpstreamError(status, message) {
	const text = message.toLowerCase();
	if (status === 401) return {
		kind: "auth",
		status,
		message,
		retryable: false,
		needsLogin: true
	};
	if (status === 403) {
		if (looksLikeQuotaMessage(text)) return {
			kind: "quota",
			status,
			message,
			retryable: false,
			needsLogin: false
		};
		if (text.includes("session") || text.includes("forbidden") || text.includes("permission")) return {
			kind: "auth",
			status,
			message,
			retryable: true,
			needsLogin: false
		};
		return {
			kind: "overloaded",
			status,
			message,
			retryable: true,
			needsLogin: false
		};
	}
	if (status === 429) return {
		kind: "rate-limit",
		status,
		message,
		retryable: true,
		needsLogin: false
	};
	if (status === 413 || status === 400 && looksLikeLengthError(text)) return {
		kind: "context",
		status,
		message: `${message}\n${CONTEXT_LIMIT_HINT}`,
		retryable: false,
		needsLogin: false
	};
	if (status === 400 && (text.includes("model") || text.includes("param"))) return {
		kind: "model",
		status,
		message,
		retryable: false,
		needsLogin: false
	};
	if (status >= 500) return {
		kind: "server",
		status,
		message,
		retryable: true,
		needsLogin: false
	};
	return {
		kind: "server",
		status,
		message,
		retryable: status >= 500,
		needsLogin: false
	};
}
/** 这条 403 是不是「免费额度用尽」（措辞见 quota.ts 的注释）。 */
function looksLikeQuotaMessage(text) {
	if (/overloaded|full inference timed out/.test(text)) return false;
	return /used up\b.*\bquota/.test(text) || /\bquota\b.*\breset/.test(text) || /insufficient_quota|usage_not_included|quota exceeded|freeusagelimiterror/.test(text);
}
function looksLikeLengthError(text) {
	return text.includes("too long") || text.includes("prompt length") || text.includes("maximum input length") || text.includes("context length") || text.includes("overlimit") || text.includes("too many tokens");
}
/**
* 流式响应里**中途**出现的鉴权错误。
*
* 上游偶尔会在已经开流之后用一帧 `data: {"error":…}` 报「invalid accessToken」，
* 然后直接断开。这类帧不是正文，若原样透传，宿主会把它当内容或直接以「密钥无效」中止。
* 这里把它识别出来，交给 shim 记录/处理。
*/
function streamAuthError(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return void 0;
	const payload = trimmed.slice(5).trim();
	if (payload === "" || payload === "[DONE]") return void 0;
	if (!/error|invalid|unauthor|forbidden|401/i.test(payload)) return void 0;
	try {
		const parsed = JSON.parse(payload);
		if (!isObject(parsed)) return void 0;
		const candidates = [];
		const error = parsed.error;
		if (typeof error === "string") candidates.push(error);
		if (isObject(error)) candidates.push(error.message, error.code, error.type);
		candidates.push(parsed.message, parsed.code, parsed.errorCode, parsed.errorMsg);
		for (const candidate of candidates) {
			if (typeof candidate !== "string" || candidate === "") continue;
			if (/invalid accessToken|unauthor|forbidden|invalid[ _-]?token|token.*(expired|invalid)|4016/i.test(candidate)) return candidate;
		}
	} catch {
		return;
	}
}
/** 从一次非流式响应体里取用量。 */
function usageFromJson(body) {
	if (!isObject(body)) return {};
	const usage = body.usage;
	if (!isObject(usage)) return {};
	const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens);
	const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens);
	return {
		...input === void 0 ? {} : { inputTokens: input },
		...output === void 0 ? {} : { outputTokens: output }
	};
}
/**
* 从一行 SSE `data:` 里取用量。
*
* 流式响应通常在最后一个块带 `usage`，也可能压根不带 —— 拿不到就不记，绝不猜。
*/
function usageFromSseLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return void 0;
	const payload = trimmed.slice(5).trim();
	if (payload === "" || payload === "[DONE]") return void 0;
	if (!payload.includes("usage")) return void 0;
	try {
		const usage = usageFromJson(JSON.parse(payload));
		return usage.inputTokens === void 0 && usage.outputTokens === void 0 ? void 0 : usage;
	} catch {
		return;
	}
}
function numberOrUndefined(value) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
}
/**
* 流式响应里第一帧的错误。
*
* 上游有时以 **200 + SSE** 的形式报错：第一帧是 `data: {"error":{...}}`。如果原样透传给
* pi-ai，它会把这段当正文渲染出来，用户看到一堆 JSON 而不是错误提示。
*/
function firstFrameError(text) {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		try {
			const parsed = JSON.parse(payload);
			if (!isObject(parsed)) continue;
			const error = parsed.error;
			if (isObject(error) && typeof error.message === "string") return error.message;
			if (typeof error === "string" && error !== "") return error;
		} catch {}
	}
}
// src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* The 127.0.0.1 bind alone is not a trust boundary (any local process or a
* DNS-rebinding page can reach 127.0.0.1), so both surfaces also check the
* Host and Origin headers.
*
* @module dsh-codearts/loopback
*/
/**
* Loopback hostnames a local plugin surface may be addressed by.
*
* `0.0.0.0` and `::` are deliberately absent: they are wildcard *bind*
* addresses, not loopback identities, and accepting them in a Host header
* would let a request that never went through the loopback interface pass.
*/
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
// src/shim.ts
/**
* 本机回环 shim：把 pi-ai 的 OpenAI 请求翻译成 DevEco 的请求。
*
* 为什么要有这一层，而不是让适配器直连上游：
*
* - 上游需要一批 pi-ai 不会发的头（`Session-Id` / `Chat-Id` / `x-deveco-task` / `x-deveco-client`）；
* - 非流式走另一条路径；
* - 每轮结束要 `POST exitSessionQueue` 放槽位；
* - 多账号轮转、失败换号、并发闸门、用量记账都发生在这一层；
* - 请求体要按上游的六条硬规则重写（`normalize.ts`）。
*
* 适配器那边只需把 `baseUrl` 指向这里、apiKey 用这里发的随机 secret，其余照旧。
*
* @module dsh-deveco/shim
*/
/** 等一个本地槽位最多等多久。 */
const SLOT_WAIT_MS = 5e3;
/** 最多换几个账号重试（每个账号只试一次）。 */
const MAX_ACCOUNT_ATTEMPTS = 3;
/**
* 上游返回 401 后的重试策略：等 5 秒 → 刷新令牌 → 重试，最多 5 次。
*
* 等这 5 秒不是礼节：令牌服务有短暂的传播延迟，401 之后立刻刷新经常还是旧状态；
* 5 秒能让新令牌真正生效。5 次仍然 401 就认为这个号确实失效，停止本次请求。
*/
const AUTH_RETRY_DELAY_MS = 5e3;
const AUTH_RETRY_MAX = 5;
/**
* 连接层失败（ECONNRESET / 超时 / DNS）原地重试次数与间隔。
*
* 这类抖动以前会立刻换号，而单账号时「换号」等于直接失败 —— 用户看到的就是推理中途
* 突然中断。先原地重试一两次通常就过去了。
*/
const NETWORK_RETRY_MAX = 2;
const NETWORK_RETRY_DELAY_MS = 800;
/** 实际等待时长（测试可以设成 0 或几毫秒）。 */
function authRetryDelayMs() {
	return envNumber("DEVECO_AUTH_RETRY_DELAY_MS", AUTH_RETRY_DELAY_MS);
}
/** 请求体上限。 */
const MAX_BODY_BYTES = 33554432;
/** 探首帧时最多缓冲多少字节。 */
const PEEK_LIMIT = 8192;
/** 可被 abort 打断的等待。 */
function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** OpenAI 风格的错误体（pi-ai 认识这个形状）。 */
function openAiError(res, status, message, type = "upstream_error") {
	json$1(res, status, { error: {
		message,
		type,
		code: status
	} });
}
function readBody$1(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", (error) => reject(error));
	});
}
/** 归一化上下文：从目录里拿这条模型的声明。 */
function contextForModel(catalog, requestedModel) {
	const info = catalog.find(requestedModel);
	const ctx = {
		model: info?.wireId ?? upstreamModelId(requestedModel),
		...info?.thinking === void 0 ? {} : { levels: info.thinking.levels },
		...info?.reasoning === true ? { reasoning: true } : {},
		textOnly: info !== void 0 && info.supportsImages !== true,
		visionModel: process.env.DEVECO_VISION_MODEL?.trim() || "Qwen3_5_397B_A17B_w8a8_single"
	};
	return info === void 0 ? { ctx } : {
		info,
		ctx
	};
}
function headerValue(headers, name) {
	const raw = headers[name];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function createDevecoShim(options) {
	const { store, pool, catalog, usage, quota, logger } = options;
	const secret = randomUUID().replace(/-/g, "");
	const queue = new DevecoQueueGate({
		maxConcurrent: envNumber("DEVECO_MAX_CONCURRENCY", 1),
		maxQueue: envNumber("DEVECO_MAX_QUEUE", 3),
		cooldownMs: envNumber("DEVECO_QUEUE_COOLDOWN_MS", DEFAULT_QUEUE_COOLDOWN_MS)
	});
	const idleTimeoutMs = envNumber("UPSTREAM_IDLE_TIMEOUT_MS", DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS);
	let server;
	let port = 0;
	const stats = { port: 0 };
	/**
	* 记一条失败，供 /doctor 回看。
	*
	* 为什么需要：统计字段只保留「最后一次请求」，一次成功就会把几分钟前的失败擦掉 ——
	* 用户再来问「刚才为什么失败」时已经无从查证。滚动保留最近 5 条。
	*/
	const recordFailure = (account, status, kind, message) => {
		const trimmed = message.length > 300 ? `${message.slice(0, 300)}…` : message;
		stats.recentFailures = [{
			at: Date.now(),
			account,
			status,
			kind,
			message: trimmed
		}, ...stats.recentFailures ?? []].slice(0, 5);
	};
	const authorized = (req) => {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		return (header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim()) === secret;
	};
	const handleModels = (req, res) => {
		if (!hostIsLoopback(req.headers.host)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		json$1(res, 200, {
			object: "list",
			data: filterEnabledModels(catalog.current(), options.enabledModels?.()).map((model) => ({
				id: exposedModelId(model.wireId),
				object: "model",
				owned_by: "deveco",
				...model.contextWindowKnown === true ? { context_length: model.contextWindow } : {},
				...model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {}
			}))
		});
	};
	/**
	* 把上游响应写回 pi-ai，并在结束时释放服务端排队槽位。
	*
	* `exitSessionQueue` 必须在**这一层的 finally** 里调：上游按 (Session-Id, Chat-Id) 记
	* 轮次账，漏一次就少一个可用名额，而且是静默的。
	*/
	const pipeUpstream = async (res, params) => {
		const { response, stream, accountId, wireModel, identity, accessToken, started } = params;
		let usageRecord = {};
		try {
			if (!stream) {
				const text = await response.text();
				try {
					usageRecord = usageFromJson(JSON.parse(text));
				} catch {}
				usage.record({
					account: accountId,
					model: wireModel,
					ok: true,
					ms: Date.now() - started,
					...usageRecord.inputTokens === void 0 ? {} : { inputTokens: usageRecord.inputTokens },
					...usageRecord.outputTokens === void 0 ? {} : { outputTokens: usageRecord.outputTokens }
				});
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(text)
				});
				res.end(text);
				return;
			}
			const body = response.body;
			if (body === null) {
				openAiError(res, 502, "dsh-deveco: upstream returned an empty stream");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			});
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let carry = "";
			let peeked = "";
			let decided = false;
			let idleTimer;
			const armIdle = () => {
				if (idleTimer !== void 0) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					logger?.warn("dsh-deveco: upstream stream idle timeout; aborting this turn");
					reader.cancel().catch(() => {});
				}, idleTimeoutMs);
				idleTimer.unref?.();
			};
			try {
				armIdle();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					armIdle();
					if (value === void 0) continue;
					let text = decoder.decode(value, { stream: true });
					if (!decided) {
						peeked += text;
						if (peeked.length < PEEK_LIMIT && !peeked.includes("\n")) continue;
						decided = true;
						const early = firstFrameError(peeked);
						if (early !== void 0) {
							await reader.cancel().catch(() => {});
							const classified = classifyUpstreamError(400, early);
							stats.lastError = `early: ${early}`;
							openAiError(res, 502, classified.message, classified.kind);
							return;
						}
						text = peeked;
						peeked = "";
					}
					carry += text;
					const newline = carry.lastIndexOf("\n");
					if (newline !== -1) {
						const complete = carry.slice(0, newline);
						carry = carry.slice(newline + 1);
						for (const line of complete.split("\n")) {
							const usageLine = usageFromSseLine(line);
							if (usageLine !== void 0) usageRecord = usageLine;
							const authError = streamAuthError(line);
							if (authError !== void 0) {
								stats.lastStreamAuthError = authError;
								stats.lastError = `stream-auth: ${authError}`;
								logger?.warn(`dsh-deveco: upstream denied the token mid-stream: ${authError}`);
							}
						}
					}
					res.write(value);
				}
				if (carry !== "") {
					const usageLine = usageFromSseLine(carry);
					if (usageLine !== void 0) usageRecord = usageLine;
				}
			} catch (error) {
				logger?.debug(`dsh-deveco: upstream stream ended early (${error instanceof Error ? error.message : String(error)})`);
			} finally {
				if (idleTimer !== void 0) clearTimeout(idleTimer);
				res.end();
				usage.record({
					account: accountId,
					model: wireModel,
					ok: true,
					ms: Date.now() - started,
					...usageRecord.inputTokens === void 0 ? {} : { inputTokens: usageRecord.inputTokens },
					...usageRecord.outputTokens === void 0 ? {} : { outputTokens: usageRecord.outputTokens }
				});
			}
		} finally {
			await exitSessionQueue(accessToken, identity, wireModel).catch(() => {});
		}
	};
	const handleChat = async (req, res) => {
		if (!hostIsLoopback(req.headers.host)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!authorized(req)) {
			openAiError(res, 401, "dsh-deveco: missing or wrong shim token", "auth_error");
			return;
		}
		let body;
		try {
			const parsed = JSON.parse(await readBody$1(req));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			body = parsed;
		} catch {
			openAiError(res, 400, "dsh-deveco: request body is not a JSON object", "invalid_request_error");
			return;
		}
		const stream = body.stream === true;
		const requestedModel = typeof body.model === "string" ? body.model : "";
		const { ctx } = contextForModel(catalog, requestedModel);
		const normalized = normalizeChatBody(body, ctx);
		const prepared = normalized.body;
		if (normalized.notes.length > 0) logger?.debug(`dsh-deveco: normalized request (${normalized.notes.join(", ")})`);
		stats.lastMaxTokens = typeof prepared.max_tokens === "number" ? prepared.max_tokens : void 0;
		stats.lastStream = stream;
		if (!await queue.acquire()) {
			openAiError(res, 429, QUEUE_FULL_MESSAGE, "rate_limit_error");
			return;
		}
		const controller = new AbortController();
		const onClose = () => controller.abort();
		res.on("close", onClose);
		const exclude = /* @__PURE__ */ new Set();
		let lastError;
		/** 本请求真正尝试过的账号数（用于区分「压根没有可用账号」和「试过但都失败了」）。 */
		let attemptedAccounts = 0;
		try {
			for (let index = 0; index < MAX_ACCOUNT_ATTEMPTS; index += 1) {
				if (!await pool.waitForFreeSlot(SLOT_WAIT_MS, controller.signal)) {
					lastError ??= {
						kind: "rate-limit",
						status: 429,
						message: "every DevEco account is busy right now; please retry shortly",
						retryable: false,
						needsLogin: false
					};
					break;
				}
				const accountId = pool.pick(exclude);
				if (accountId === void 0) {
					if (attemptedAccounts === 0) lastError = {
						kind: "auth",
						status: 401,
						message: "no usable DevEco account; sign in from the DevEco plugin card",
						retryable: false,
						needsLogin: true
					};
					break;
				}
				attemptedAccounts += 1;
				if (!pool.acquire(accountId)) {
					exclude.add(accountId);
					continue;
				}
				try {
					const wireModel = typeof prepared.model === "string" ? upstreamModelId(prepared.model) : "";
					const identity = identityFromHeaders(req.headers, prepared);
					const project = headerValue(req.headers, "x-deveco-project");
					const parent = headerValue(req.headers, "x-deveco-parent-session");
					let resolved = await store.resolve(accountId);
					if (resolved === void 0) {
						pool.disable(accountId, "credential needs sign-in");
						lastError = {
							kind: "auth",
							status: 401,
							message: "DevEco account needs to sign in again",
							retryable: true,
							needsLogin: true
						};
						exclude.add(accountId);
						continue;
					}
					let response;
					let started = Date.now();
					let authAttempts = 0;
					let networkAttempts = 0;
					/**
					* 401 的处理：**等 5 秒 → 刷新令牌 → 重试**，最多 5 次。
					*
					* 为什么要等：上游判 401 之后立刻刷新，经常还会拿到旧状态（令牌服务有短暂
					* 传播延迟），5 秒能让新令牌真正生效。为什么要「重试」而不是直接判死：
					* accessToken 只有 30 分钟，长回合里中途过期很常见，续期后就能接着推理。
					*/
					for (;;) {
						const requestHeaders = buildChatHeaders(resolved.accessToken, identity, {
							...project === void 0 ? {} : { project },
							...parent === void 0 ? {} : { parentSession: parent }
						});
						started = Date.now();
						try {
							response = await fetch(chatUrl(stream), {
								method: "POST",
								headers: requestHeaders,
								body: JSON.stringify({
									...prepared,
									model: wireModel,
									stream
								}),
								signal: controller.signal
							});
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							usage.record({
								account: accountId,
								model: wireModel,
								ok: false,
								ms: Date.now() - started
							});
							pool.noteError(accountId, 3, 3e4, "network error");
							lastError = {
								kind: "network",
								status: 0,
								message,
								retryable: true,
								needsLogin: false
							};
							recordFailure(accountId, 0, "network", message);
							if (networkAttempts < NETWORK_RETRY_MAX && !controller.signal.aborted) {
								networkAttempts += 1;
								logger?.warn(`dsh-deveco: upstream connection failed (${message}); retry ${networkAttempts}/${NETWORK_RETRY_MAX}`);
								await sleep(NETWORK_RETRY_DELAY_MS, controller.signal);
								if (controller.signal.aborted) {
									response = void 0;
									break;
								}
								continue;
							}
							exclude.add(accountId);
							response = void 0;
							break;
						}
						if (response.status !== 401) break;
						if (authAttempts >= AUTH_RETRY_MAX) break;
						authAttempts += 1;
						const denied = await readErrorText(response);
						await store.noteTokenExpired(accountId).catch(() => {});
						stats.lastAuthRetry = authAttempts;
						stats.lastError = `upstream 401: ${denied}`;
						logger?.warn(`dsh-deveco: upstream 401 (${denied}); retry ${authAttempts}/${AUTH_RETRY_MAX} after ${authRetryDelayMs()}ms`);
						await sleep(authRetryDelayMs(), controller.signal);
						if (controller.signal.aborted) {
							lastError = {
								kind: "network",
								status: 0,
								message: "request aborted",
								retryable: false,
								needsLogin: false
							};
							exclude.add(accountId);
							response = void 0;
							break;
						}
						if (!await store.forceRefresh(accountId).catch(() => false)) {
							logger?.warn("dsh-deveco: refreshing the token after a 401 failed; giving up on this account");
							break;
						}
						const again = await store.resolve(accountId);
						if (again === void 0) break;
						resolved = again;
					}
					if (response === void 0) continue;
					if (response.ok) {
						pool.noteSuccess(accountId);
						quota.noteOk(accountId);
						await store.noteTokenWorked(accountId, resolved.credential.accessTokenIssuedAt).catch(() => {});
						stats.lastAccount = accountId;
						stats.lastModel = wireModel;
						stats.lastStatus = response.status;
						stats.lastLatencyMs = Date.now() - started;
						stats.lastError = void 0;
						await pipeUpstream(res, {
							response,
							stream,
							accountId,
							wireModel,
							identity,
							accessToken: resolved.accessToken,
							started
						});
						return;
					}
					const message = await readErrorText(response);
					const classified = classifyUpstreamError(response.status, message);
					usage.record({
						account: accountId,
						model: wireModel,
						ok: false,
						ms: Date.now() - started
					});
					stats.lastStatus = response.status;
					stats.lastError = `${classified.kind}: ${message}`;
					recordFailure(accountId, response.status, classified.kind, message);
					if (looksLikeQuotaExhausted(response.status, message)) quota.noteExhausted(accountId, message);
					if (classified.kind === "quota") {
						const resetAt = parseQuotaResetAt(message);
						const resetText = resetAt === void 0 ? "" : ` It resets at ${new Date(resetAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}.`;
						lastError = {
							kind: "quota",
							status: response.status,
							message: `DevEco free quota for this account is used up.${resetText} ${message}`,
							retryable: false,
							needsLogin: false
						};
						exclude.add(accountId);
						break;
					}
					if (classified.needsLogin) {
						if (authAttempts >= AUTH_RETRY_MAX) {
							await store.markRejected(accountId, `upstream 401 after ${authAttempts} retries: ${message}`);
							pool.disable(accountId, `upstream 401 after ${authAttempts} retries`);
							lastError = {
								kind: "auth",
								status: 401,
								message: `DevEco rejected the token ${authAttempts} times in a row (${message}); sign in again from the DevEco plugin card`,
								retryable: true,
								needsLogin: true
							};
						} else {
							pool.noteError(accountId, 3, 2e4, `auth: ${message}`);
							lastError = classified;
						}
					} else if (classified.kind === "rate-limit" || classified.kind === "overloaded" || classified.kind === "server") {
						pool.noteError(accountId, 3, 2e4, `${classified.kind}: ${message}`);
						lastError = classified;
					} else lastError = classified;
					exclude.add(accountId);
					if (classified.needsLogin && authAttempts >= AUTH_RETRY_MAX) break;
					if (classified.retryable !== true && classified.needsLogin !== true) break;
				} finally {
					pool.release(accountId);
					if ((pool.get(accountId)?.activeConcurrent ?? 0) === 0) try {
						options.onAccountIdle?.(accountId);
					} catch (error) {
						logger?.debug(`dsh-deveco: onAccountIdle failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			const error = lastError ?? {
				kind: "server",
				status: 500,
				message: "dsh-deveco: no account could serve this request",
				retryable: false,
				needsLogin: false
			};
			if (!res.headersSent) openAiError(res, error.status === 0 ? 502 : error.status, error.message, error.kind);
			else res.end();
		} finally {
			res.off("close", onClose);
			queue.release();
		}
	};
	const handler = (req, res) => {
		const path = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname.replace(/\/$/, "");
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
			handleModels(req, res);
			return;
		}
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			handleChat(req, res).catch((error) => {
				logger?.warn("dsh-deveco: shim request failed", error);
				if (!res.headersSent) openAiError(res, 500, error instanceof Error ? error.message : String(error));
				else res.end();
			});
			return;
		}
		if (req.method === "GET" && path === "/health") {
			json$1(res, 200, {
				ok: true,
				accounts: pool.list().length,
				queue: queue.snapshot(),
				stats
			});
			return;
		}
		json$1(res, 404, { error: "not found" });
	};
	return {
		baseUrl: () => `http://127.0.0.1:${port}`,
		token: () => secret,
		ready: new Promise((resolve, reject) => {
			const instance = createServer(handler);
			instance.once("error", reject);
			instance.listen(0, "127.0.0.1", () => {
				server = instance;
				port = instance.address()?.port ?? 0;
				stats.port = port;
				resolve();
			});
		}),
		close: async () => {
			queue.dispose();
			const instance = server;
			server = void 0;
			if (instance === void 0) return;
			await new Promise((resolve) => {
				instance.close(() => resolve());
				setTimeout(resolve, 500).unref?.();
			});
		},
		stats: () => ({ ...stats })
	};
}
// node_modules/.pnpm/@earendil-works+pi-ai@1.5.2_bfcf7ff884c6418f8e350fe360d1f5d5/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js
const openAICompletionsApi = () => lazyApi(() => import("./openai-completions-BKw9Uk1C.mjs"));
// src/adapter.ts
/**
* `deveco` 这个 pi-ai provider。
*
* 一个适配器，把 DSH 的 LLM seam 接到本机回环 shim 上（`shim.ts` 做真正的上游翻译）。
* 这里只描述模型、把 `baseUrl` 指向 shim、并把 apiKey 换成 shim 的进程内 secret。
*
* @module dsh-deveco/adapter
*/
/** 这个 bundle 拥有的 provider 路由。与 `cordis.patch.yml` 保持一致。 */
const DEVECO_PROVIDER = "deveco";
/**
* 等上游开流时的空闲上限。
*
* 90s：DevEco 的免费后端实测会「吐几个 token 然后长时间静默」。给到 90s 既能容忍首
* token 冷启动和推理间隙，又能让 DSH 自己的重试策略更快接管（它把 TIMEOUT 当可重试）。
*/
const DEVECO_STREAM_IDLE_TIMEOUT_MS = 9e4;
/** 订阅额度没有可算的单价，一律报 0。 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/** 惰性的 pi-ai 凭证面：deveco 路由只靠 shim 的 secret 鉴权。 */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-deveco: the deveco route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** pi-ai 认的档位，按由弱到强排列。 */
const REASONING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* 上游声明的思考档位 → pi-ai 的推理元数据。
*
* 上游没声明的档位一律钉成 `null`：pi-ai 把「没写」当成「支持」，漏掉的话界面会给一个
* 只会 high/max 的模型显示 Off/Minimal/Low/Medium。`off` 同样钉死 —— 上游默认已经在思考，
* 声称支持 Off 只会发出一个不带档位的请求，然后照样思考。
*/
function thinkingFields(strengths) {
	const offered = new Set(strengths ?? []);
	if (!REASONING_LEVELS.some((level) => level !== "off" && offered.has(level))) return { reasoning: false };
	const map = {};
	for (const level of REASONING_LEVELS) map[level] = offered.has(level) ? level : null;
	return {
		reasoning: true,
		thinkingLevelMap: map
	};
}
/**
* 一条目录项 → pi-ai 模型描述（指向 shim）。
*
* `maxTokens` 是**单次输出**上限，pi-ai 在请求未带 `max_tokens` 时直接拿它当天花板；
* 它和 `contextWindow` 完全无关。给太小（曾经兜底 8192）会让长回答与推理在中途被截断。
*/
function piModelFor(info, baseUrl) {
	const thinking = thinkingFields(info.thinking?.levels);
	const reasoning = info.reasoning === true || thinking.reasoning;
	const ceiling = outputCeiling();
	const declared = info.maxTokens > 0 ? info.maxTokens : ceiling;
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: DEVECO_PROVIDER,
		baseUrl,
		input: info.supportsImages ? ["text", "image"] : ["text"],
		reasoning,
		...thinking.thinkingLevelMap === void 0 ? {} : { thinkingLevelMap: thinking.thinkingLevelMap },
		cost: NO_COST,
		contextWindow: info.contextWindow > 0 ? info.contextWindow : 32768,
		maxTokens: Math.min(declared, ceiling)
	};
}
function createDevecoAdapter(options) {
	const { shim, catalog, enabledModels, resolveAttachments } = options;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => piModelFor(info, baseUrl));
	};
	const provider = {
		...createProvider({
			id: DEVECO_PROVIDER,
			name: "DevEco",
			auth: { apiKey: {
				name: "DevEco shim key",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "DevEco"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: DEVECO_PROVIDER,
		displayName: "DevEco",
		streamIdleTimeoutMs: DEVECO_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-deveco retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[DEVECO_PROVIDER, profile]]);
	return {
		adapter: new DevecoPiAiAdapter(catalog, enabledModels, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[DEVECO_PROVIDER, profile]]);
		}
	};
}
/** 把**对外**模型面收窄到用户勾选的子集（分发不受影响）。 */
var DevecoPiAiAdapter = class extends PiAiAdapter {
	catalog;
	enabledModels;
	constructor(catalog, enabledModels, options) {
		super(options);
		this.catalog = catalog;
		this.enabledModels = enabledModels;
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const allowed = filterEnabledModels(this.catalog.current(), this.enabledModels?.());
		const catalogIds = new Set(this.catalog.current().map((entry) => entry.id));
		const allowedIds = new Set(allowed.map((entry) => entry.id));
		return models.filter((model) => !catalogIds.has(model.id) || allowedIds.has(model.id));
	}
	async resolveModel(provider, model, signal) {
		return super.resolveModel(provider, model, signal);
	}
};
// src/settings-compat.ts
const compatModule = settingsModule;
function plainSettingsSchema(schema) {
	const clone = structuredClone(schema.toJSON());
	for (const node of Object.values(clone.refs ?? {})) if (node !== null && typeof node === "object" && node.meta !== void 0) delete node.meta.volatile;
	return z(clone);
}
function entryNamespaceOf(ctx) {
	const compat = ctx;
	const entry = compat.fiber?.entry;
	const candidates = [
		entry?.options?.id,
		entry?.id,
		compat.loader?.locate?.(compat.fiber)
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
}
function resolveSettingsNamespaceCompat(ctx, provider, fallback) {
	if (compatModule.installSettingsSection !== void 0) return fallback;
	if (provider === void 0 || provider === null) return fallback;
	const candidate = provider;
	if (candidate.installSection !== void 0) return fallback;
	if (candidate.configure !== void 0) return entryNamespaceOf(ctx) ?? fallback;
	return fallback;
}
function installSettingsSectionCompat(ctx, ns, schema, entry, hooks) {
	const legacyInstaller = compatModule.installSettingsSection;
	if (legacyInstaller !== void 0) {
		legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks);
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		const provider = sctx.get("settings");
		if (provider === void 0) return;
		if (provider.installSection !== void 0) {
			provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks);
			return;
		}
		if (provider.configure === void 0) throw new TypeError("dsh-settings exposes neither installSection nor configure");
		sctx.effect(() => {
			const dispose = provider.configure?.({ auto: false }, ctx.fiber);
			return typeof dispose === "function" ? dispose : () => {};
		});
		const namespace = entryNamespaceOf(ctx);
		if (namespace !== void 0) {
			const refresh = () => {
				const descriptor = provider.describe?.().find((entry) => String(entry.ns) === namespace);
				if (descriptor?.value !== void 0) hooks.setSource?.(() => descriptor.value);
				hooks.onChange();
			};
			const settingsEvents = sctx;
			sctx.effect(() => settingsEvents.on("settings/document-updated", (updated) => {
				if (String(updated) === namespace) refresh();
			}));
		}
	});
}
// src/login.ts
/**
* 浏览器登录：DevEco 授权页 + 本机回环回调。
*
* 流程（不是标准 OAuth2，没有 PKCE、没有 client_secret）：
*
* 1. 生成 32 位十六进制 `code`（客户端密钥）。
* 2. 在 `127.0.0.1` 上起一个回调服务，端口从 `10101 / 34567–34570` 里挑第一个空的。
* 3. 把浏览器带到 `console/DevEcoIDE/apply?port=…&appid=1008&code=…`。
* 4. 用户在华为页面登录，浏览器被跳回 `http://127.0.0.1:<port>/callback?code=…&tempToken=…&siteId=1`。
* 5. `tempToken` 换 `jwtToken`（响应体是**纯文本 JWT**，不是 JSON）。
* 6. `jwtToken` 换 `accessToken`，装配成凭证。
*
* 安全边界：回调服务只绑 loopback；`code` 必须与本次生成的密钥逐字相同（防止别的
* 本地进程往这个端口乱投递）；只接受 `siteId=1`（中国站）。
*
* @module dsh-deveco/login
*/
/** 带分类的登录错误。 */
var LoginError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.name = "LoginError";
		this.kind = kind;
	}
};
/**
* 只绑 loopback 的一次性回调服务。
*
* 一个实例只服务一次登录：`code` 对得上的第一个回调即 resolve，其它投递一律忽略。
*/
var LoginCallbackServer = class {
	server;
	port = 0;
	secret;
	settle;
	reject;
	payload;
	closed = false;
	constructor(secret) {
		this.secret = secret;
	}
	/** 依次尝试候选端口，绑定成功即返回真实端口。 */
	async start() {
		this.payload ??= new Promise((resolve, reject) => {
			this.settle = resolve;
			this.reject = reject;
		});
		for (const port of DEVECO_CALLBACK_PORTS) {
			const bound = await this.tryListen(port);
			if (bound !== void 0) {
				this.port = bound;
				return bound;
			}
		}
		throw new LoginError("server", `could not bind any callback port (tried ${DEVECO_CALLBACK_PORTS.join(", ")})`);
	}
	tryListen(port) {
		return new Promise((resolve) => {
			const server = createServer((req, res) => this.handle(req, res));
			server.once("error", () => {
				server.close();
				resolve(void 0);
			});
			server.listen(port, "127.0.0.1", () => {
				this.server = server;
				resolve(server.address()?.port ?? port);
			});
		});
	}
	handle(req, res) {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
		if (url.pathname !== "/callback") {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
			return;
		}
		if (req.method === "GET") {
			this.accept(url.searchParams, res);
			return;
		}
		if (req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => {
				body += String(chunk);
				if (body.length > 65536) req.destroy();
			});
			req.on("end", () => this.accept(new URLSearchParams(body), res));
			return;
		}
		res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Method Not Allowed");
	}
	accept(params, res) {
		const code = params.get("code");
		if (code === null || code !== this.secret) {
			res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Bad Request");
			return;
		}
		const payload = {
			code,
			tempToken: params.get("tempToken"),
			siteId: params.get("siteId"),
			quit: params.get("quit")
		};
		const failed = payload.quit === "true" || payload.quit === "access_denied";
		res.writeHead(302, { Location: failed ? DEVECO_FAILED_URL : DEVECO_SUCCESS_URL });
		res.end();
		const settle = this.settle;
		this.settle = void 0;
		settle?.(payload);
	}
	/** 等一次回调（带总预算）。 */
	async waitForCallback(timeoutMs = LOGIN_TIMEOUT_MS) {
		const payload = this.payload;
		if (payload === void 0) throw new LoginError("server", "callback server was not started");
		let timer;
		try {
			return await Promise.race([payload, new Promise((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(new LoginError("timeout", "timed out waiting for the browser to finish signing in"));
				}, timeoutMs);
				timer.unref?.();
			})]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	/** 收摊。可重复调用。 */
	async close() {
		if (this.closed) return;
		this.closed = true;
		const reject = this.reject;
		this.settle = void 0;
		this.reject = void 0;
		const server = this.server;
		this.server = void 0;
		if (server !== void 0) await new Promise((resolve) => {
			server.close(() => resolve());
			setTimeout(resolve, 500).unref?.();
		});
		reject?.(new LoginError("cancelled", "login cancelled"));
	}
};
/** 生成 32 位十六进制客户端密钥。 */
function newClientSecret() {
	return randomUUID().replace(/-/g, "");
}
/** 拼登录页地址。 */
function buildLoginUrl(port, secret) {
	return `${DEVECO_AUTH_URL}?port=${port}&appid=${DEVECO_APP_ID}&code=${secret}`;
}
/** 打开登录页的平台命令（Windows 上 URL 必须加引号，否则 `&` 会被命令解释器切开）。 */
function browserOpenCommand(platform, url) {
	if (platform === "win32") return {
		command: `start "" "${url}"`,
		args: [],
		shell: true
	};
	if (platform === "darwin") return {
		command: "open",
		args: [url],
		shell: false
	};
	return {
		command: "xdg-open",
		args: [url],
		shell: false
	};
}
/** 把 URL 交给系统默认浏览器。失败不抛：卡片会把地址显示出来让用户自己点。 */
function openBrowser(url) {
	try {
		const { command, args, shell } = browserOpenCommand(process.platform, url);
		const child = spawn(command, args, {
			shell,
			detached: true,
			stdio: "ignore"
		});
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
/** 登录页必须是官方域名 https（防止配置/输入把用户带到别处）。 */
function assertOfficialAuthUrl(url) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.hostname !== "cn.devecostudio.huawei.com") throw new LoginError("server", `refusing to open an unexpected sign-in URL: ${parsed.origin}`);
}
/**
* `tempToken` → `jwtToken`。
*
* 响应体是**纯文本 JWT**（不是 JSON），所以 `text()` 后 `trim()`；上游偶尔把 `&...`
* 粘在 tempToken 尾巴上，先切掉。
*/
async function exchangeTempToken(tempToken, signal) {
	const token = tempToken.split("&")[0] ?? "";
	if (token === "") throw new LoginError("exchange", "the callback carried an empty tempToken");
	const url = new URL(DEVECO_TEMP_TOKEN_URL);
	url.searchParams.set("tempToken", token);
	url.searchParams.set("site", "CN");
	url.searchParams.set("version", "1.0.0");
	url.searchParams.set("appid", DEVECO_APP_ID);
	const response = await fetch(url, {
		method: "GET",
		headers: {
			"User-Agent": BROWSER_USER_AGENT,
			"accept-language": "zh-CN"
		},
		signal: signal ?? AbortSignal.timeout(2e4)
	});
	if (!response.ok) throw new LoginError("exchange", `jwtToken exchange failed with HTTP ${response.status}`);
	const jwtToken = (await response.text()).trim();
	if (jwtToken.split(".").length !== 3) throw new LoginError("exchange", "upstream returned something that is not a jwtToken");
	return jwtToken;
}
/** 把 jwtToken 换成一个装好的凭证；失败抛 `LoginError`。 */
async function credentialFromJwtToken(jwtToken, options = {}) {
	const payload = parseJwtPayload(jwtToken);
	const refreshed = await requestTokenRefresh(jwtToken, options.signal);
	if (!refreshed.ok) throw new LoginError("exchange", `the jwtToken could not be exchanged for an access token (${refreshed.kind}: ${refreshed.message})`);
	const value = refreshed.value;
	const now = Date.now();
	return {
		jwtToken,
		accessToken: value.accessToken,
		accessTokenIssuedAt: now,
		accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_MS,
		...value.refreshToken === void 0 ? {} : { refreshToken: value.refreshToken },
		...payload.userId === void 0 ? {} : { userId: payload.userId },
		...payload.userName === void 0 ? {} : { userName: payload.userName },
		...payload.nationalCode === void 0 ? {} : { nationalCode: payload.nationalCode },
		...payload.isRealName === void 0 ? {} : { isRealName: payload.isRealName },
		...value.isRealName === void 0 ? {} : { isRealName: value.isRealName },
		...options.label === void 0 ? {} : { label: options.label },
		storedAt: now,
		lastLoginAt: now
	};
}
/**
* 起一次登录。
*
* 端口绑定是同步的一小步（毫秒级），先等它完成才拿得到真正要展示给用户的 URL。
* 之后的等待都在 `result` 上，卡片可以轮询它，不必挂着一个长请求。
*/
async function startLogin(options = {}) {
	const secret = newClientSecret();
	const server = new LoginCallbackServer(secret);
	const port = await server.start();
	const url = buildLoginUrl(port, secret);
	assertOfficialAuthUrl(url);
	if (options.openBrowser !== false) openBrowser(url);
	return {
		url,
		port,
		result: (async () => {
			try {
				const payload = await server.waitForCallback();
				if (payload.quit === "true" || payload.quit === "access_denied") throw new LoginError("cancelled", payload.quit === "access_denied" ? "access denied on the DevEco sign-in page" : "sign-in was cancelled in the browser");
				if (payload.tempToken === null || payload.tempToken === "") throw new LoginError("exchange", "the callback carried no tempToken");
				if (payload.siteId !== null && payload.siteId !== "1") throw new LoginError("region", "only China-site accounts are supported (siteId must be 1)");
				const credential = await credentialFromJwtToken(await exchangeTempToken(payload.tempToken));
				const nationalCode = (credential.nationalCode ?? "").trim().toUpperCase();
				if (nationalCode !== "" && nationalCode !== "CN") throw new LoginError("region", "only China-region (CN) accounts are supported");
				return {
					state: "done",
					credential
				};
			} catch (error) {
				return {
					state: "error",
					kind: error instanceof LoginError ? error.kind : "network",
					message: error instanceof Error ? error.message : String(error)
				};
			} finally {
				await server.close();
			}
		})(),
		cancel: () => {
			server.close();
		}
	};
}
// src/web-status.ts
const DEVECO_STATUS_PATH = "/api/deveco/status";
const DEVECO_MODELS_PATH = "/api/deveco/models";
const DEVECO_SELECTION_PATH = "/api/deveco/enabled-models";
const DEVECO_LOGIN_PATH = "/api/deveco/login";
const DEVECO_LOGIN_STATUS_PATH = "/api/deveco/login/status";
const DEVECO_TOKEN_PATH = "/api/deveco/token";
const DEVECO_ACCOUNTS_PATH = "/api/deveco/accounts";
const DEVECO_CHECKIN_PATH = "/api/deveco/checkin";
const DEVECO_REFRESH_MODELS_PATH = "/api/deveco/refresh-models";
const DEVECO_DOCK_PATH = "/api/deveco/dock";
const DEVECO_DOCTOR_PATH = "/api/deveco/doctor";
/**
* GET = 当前额度窗口与「哪些号被上游判过额度用尽」；POST = 重新探测一遍账号可用性。
*
* 注意：这**不是**查询余额。上游没有余额接口，见 `docs/PROTOCOL.md` 第 6 节。
*/
const DEVECO_QUOTA_PATH = "/api/deveco/quota";
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** 只信任来回路环的请求。 */
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** 写操作必须是 JSON。 */
function isJsonRequest(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.toLowerCase().includes("application/json");
}
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function safeMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
function toWebModel(model) {
	return {
		id: model.id,
		name: model.name,
		wireId: model.wireId,
		...model.contextWindowKnown === true && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
		...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
		...model.supportsImages ? { supportsImages: true } : {},
		...model.reasoning ? { reasoning: true } : {},
		...model.thinking === void 0 ? {} : { levels: model.thinking.levels },
		...model.hidden ? { hidden: true } : {}
	};
}
/** 组装状态文档（不含任何令牌）。 */
async function buildStatus(deps) {
	const summaries = await deps.store.list();
	const slots = new Map(deps.pool().map((entry) => [entry.id, entry]));
	const checkin = deps.checkin();
	const accounts = summaries.map((summary) => {
		const slot = slots.get(summary.id);
		const today = checkin.today[summary.id];
		return {
			...summary,
			...slot === void 0 ? {} : { slot: {
				activeConcurrent: slot.activeConcurrent,
				maxConcurrent: slot.maxConcurrent,
				coolUntil: slot.coolUntil,
				disabled: slot.disabled,
				...slot.lastError === void 0 ? {} : { lastError: slot.lastError }
			} },
			checkedInToday: today?.ok === true,
			streak: checkin.streaks[summary.id] ?? 0
		};
	});
	const dock = deps.dock();
	const learned = summaries.reduce((best, entry) => entry.ttlSamples > best.samples ? {
		ttlMs: entry.ttlMs,
		source: entry.ttlSource,
		samples: entry.ttlSamples
	} : best, {
		ttlMs: TTL_FALLBACK_MS,
		source: "default",
		samples: 0
	});
	const authTtlMs = learned.ttlMs;
	const authTtlSource = learned.source;
	const authTtlSamples = learned.samples;
	return {
		version: deps.version,
		provider: DEVECO_PROVIDER,
		node: process.version,
		signedIn: accounts.length > 0,
		accounts,
		models: deps.models().map(toWebModel),
		usage: deps.usage(),
		checkin,
		quota: deps.quota(),
		dock,
		writable: true,
		shim: deps.shimStats(),
		checkinNote: deps.checkinNote,
		authPolicy: {
			accessTokenTtlMinutes: Math.round(authTtlMs / 6e4),
			ttlSource: authTtlSource,
			ttlSamples: authTtlSamples,
			refreshSkewMinutes: Math.round(refreshSkewForTtl(authTtlMs) / 6e4)
		},
		providerRegistered: deps.providerRegistered(),
		catalogUpdatedAt: deps.catalogUpdatedAt(),
		...deps.lastDiscoveryError() === void 0 ? {} : { lastDiscoveryError: deps.lastDiscoveryError() }
	};
}
/** 勾选面板的数据。 */
function selectionOf(deps) {
	const models = deps.models();
	const enabled = deps.enabledModels();
	const allow = enabled === void 0 || enabled.length === 0 ? void 0 : new Set(enabled.map((id) => id.toLowerCase()));
	const choices = models.map((model) => ({
		...toWebModel(model),
		enabled: allow === void 0 || allow.has(model.id.toLowerCase()) || allow.has(model.wireId.toLowerCase())
	}));
	return {
		choices,
		restricted: choices.some((choice) => !choice.enabled),
		writable: true
	};
}
function statusHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		json(res, 200, { status: await buildStatus(deps) });
	};
}
function modelsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		json(res, 200, { models: deps.models().map(toWebModel) });
	};
}
function selectionHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, { selection: selectionOf(deps) });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = JSON.parse(await readBody(req));
			if (!Array.isArray(body.enabledModels) || body.enabledModels.some((id) => typeof id !== "string")) {
				json(res, 400, { error: "enabledModels must be an array of model ids" });
				return;
			}
			if (!await deps.setEnabledModels(body.enabledModels)) {
				json(res, 403, { error: "selection-not-writable" });
				return;
			}
			json(res, 200, {
				ok: true,
				selection: selectionOf(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
function loginStartHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		try {
			const accountId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("account") ?? void 0;
			const started = await deps.startLogin({ ...accountId === null || accountId === void 0 ? {} : { accountId } });
			json(res, 200, {
				url: started.url,
				port: started.port
			});
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
function loginPollHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("url") ?? "";
		if (url === "") {
			json(res, 400, { error: "missing url" });
			return;
		}
		json(res, 200, deps.pollLogin(url));
	};
}
function tokenHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "DELETE") {
			for (const summary of await deps.store.list()) await deps.store.remove(summary.id);
			json(res, 200, {
				ok: true,
				status: await buildStatus(deps)
			});
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = JSON.parse(await readBody(req));
			const jwtToken = typeof body.jwtToken === "string" ? body.jwtToken.trim() : "";
			if (jwtToken.split(".").length !== 3) {
				json(res, 400, { error: "jwtToken must be a three-part JWT" });
				return;
			}
			const credential = await credentialFromJwtToken(jwtToken, { ...typeof body.label === "string" && body.label.trim() !== "" ? { label: body.label.trim() } : {} });
			const id = await deps.store.upsert(credential);
			deps.reviveAccount(id);
			json(res, 200, {
				ok: true,
				id,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
function accountsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "DELETE") {
			const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id");
			if (id === null || id === "") {
				json(res, 400, { error: "missing id" });
				return;
			}
			await deps.store.remove(id);
			json(res, 200, {
				ok: true,
				status: await buildStatus(deps)
			});
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = JSON.parse(await readBody(req));
			const id = typeof body.id === "string" ? body.id : "";
			if (id === "") {
				json(res, 400, { error: "missing id" });
				return;
			}
			let touched = false;
			if (typeof body.paused === "boolean") touched = await deps.store.setPaused(id, body.paused) || touched;
			if (typeof body.pinned === "boolean") touched = await deps.store.setPinned(id, body.pinned) || touched;
			if (typeof body.label === "string") touched = await deps.store.setLabel(id, body.label) || touched;
			if (body.refresh === true) touched = await deps.store.forceRefresh(id) || touched;
			if (!touched) {
				json(res, 404, { error: "unknown account or nothing to change" });
				return;
			}
			deps.reviveAccount(id);
			json(res, 200, {
				ok: true,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
function checkinHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const raw = await readBody(req);
			const body = raw.trim() === "" ? {} : JSON.parse(raw);
			const accountId = typeof body.id === "string" && body.id !== "" ? body.id : void 0;
			const outcome = await deps.runCheckin({
				...accountId === void 0 ? {} : { accountId },
				force: body.force === true
			});
			for (const result of outcome.results) if (result.ok) deps.reviveAccount(result.id);
			json(res, 200, {
				outcome,
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
function quotaHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, { quota: deps.quota() });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			json(res, 200, {
				outcome: await deps.refreshQuota(),
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
function refreshModelsHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		try {
			json(res, 200, {
				...await deps.refreshModels(),
				selection: selectionOf(deps),
				status: await buildStatus(deps)
			});
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
function dockHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method === "GET") {
			json(res, 200, {
				dock: deps.dock(),
				writable: true
			});
			return;
		}
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!isJsonRequest(req)) {
			json(res, 415, { error: "content-type must be application/json" });
			return;
		}
		try {
			const body = JSON.parse(await readBody(req));
			const patch = {};
			for (const key of [
				"dock",
				"sidebar",
				"settingsEntry",
				"autoClaim"
			]) if (typeof body[key] === "boolean") patch[key] = body[key];
			if (!await deps.setDock(patch)) {
				json(res, 403, { error: "dock-not-writable" });
				return;
			}
			json(res, 200, {
				ok: true,
				dock: deps.dock(),
				writable: true
			});
		} catch (error) {
			json(res, 400, { error: safeMessage(error) });
		}
	};
}
/** 目录里模型声明过的最大输出上限（体检展示用）。 */
function maxOutputOf(status) {
	const values = status.models.map((model) => model.maxTokens ?? 0).filter((value) => value > 0);
	return values.length === 0 ? "unknown" : String(Math.max(...values));
}
/**
* 把「宿主 LLM 层实际看到了什么」写成一句人话。
*
* 排查「模型列表有、聊天框选择器没有」时，这一条是第一现场：
* 它问的是宿主的 `llm.listProviders()` / `llm.listModels()`，不是插件自己的目录。
*/
async function describeLlmDiagnostics(deps) {
	let diagnostics;
	try {
		diagnostics = await deps.llmDiagnostics();
	} catch (error) {
		return `host llm query failed: ${safeMessage(error)}`;
	}
	if (diagnostics.error !== void 0) return `host llm query failed: ${diagnostics.error}`;
	const deveco = diagnostics.providers.find((provider) => provider.id === DEVECO_PROVIDER);
	if (deveco === void 0) return `host does not list provider "${DEVECO_PROVIDER}" (it lists: ${diagnostics.providers.map((provider) => provider.id).join(", ") || "none"})`;
	return `host lists "${DEVECO_PROVIDER}" with ${deveco.models} model(s)`;
}
function doctorHandler(deps) {
	return async (req, res) => {
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		const status = await buildStatus(deps);
		const shim = deps.shimStats();
		const checks = [
			{
				id: "version",
				ok: true,
				detail: `${status.version} on ${status.node}`
			},
			{
				id: "accounts",
				ok: status.accounts.length > 0,
				detail: status.accounts.length === 0 ? "no account signed in" : `${status.accounts.length} account(s)`
			},
			{
				id: "usable-accounts",
				ok: status.accounts.some((account) => account.usable && !account.paused),
				detail: status.accounts.filter((account) => account.usable && !account.paused).length === 0 ? "every account needs sign-in or is paused" : `${status.accounts.filter((account) => account.usable && !account.paused).length} usable`
			},
			{
				id: "catalog",
				ok: status.models.length > 0,
				detail: status.models.length === 0 ? "model catalog is empty" : `${status.models.length} model(s)`
			},
			{
				id: "shim",
				ok: shim.port > 0,
				detail: shim.port > 0 ? `loopback shim on port ${shim.port}` : "shim is not listening"
			},
			{
				id: "output-ceiling",
				ok: (shim.lastMaxTokens ?? 0) !== 0 && (shim.lastMaxTokens ?? Number.MAX_SAFE_INTEGER) >= 8192,
				detail: shim.lastMaxTokens === void 0 ? `no chat request yet; models advertise up to ${maxOutputOf(status)} output tokens` : `last request sent max_tokens=${shim.lastMaxTokens} (context is independent; models advertise up to ${maxOutputOf(status)})`
			},
			{
				id: "provider",
				ok: status.providerRegistered,
				detail: status.providerRegistered ? "provider deveco is registered" : "provider deveco is NOT registered"
			},
			{
				id: "providers",
				ok: status.providerRegistered && status.accounts.length > 0 && status.models.length > 0,
				detail: await describeLlmDiagnostics(deps)
			},
			{
				id: "auth-ttl",
				ok: true,
				detail: status.authPolicy.ttlSource === "learned" ? `learned accessToken lifetime ~${status.authPolicy.accessTokenTtlMinutes} min from ${status.authPolicy.ttlSamples} expiry sample(s); refreshing ${status.authPolicy.refreshSkewMinutes} min early` : status.authPolicy.ttlSource === "extended" ? `accessToken outlived the default; lifetime raised to ~${status.authPolicy.accessTokenTtlMinutes} min; refreshing ${status.authPolicy.refreshSkewMinutes} min early` : `no expiry sample yet; assuming ${status.authPolicy.accessTokenTtlMinutes} min (refreshing ${status.authPolicy.refreshSkewMinutes} min early)`
			},
			{
				id: "recent-failures",
				ok: (shim.recentFailures ?? []).length === 0,
				detail: (shim.recentFailures ?? []).length === 0 ? "no failed upstream call recorded since start" : (shim.recentFailures ?? []).slice(0, 3).map((failure) => `${new Date(failure.at).toISOString()} ${failure.kind}/${failure.status || "n-a"} on ${failure.account}: ${failure.message}`).join(" | ")
			},
			{
				id: "auth-retry",
				ok: (shim.lastAuthRetry ?? 0) < 5,
				detail: shim.lastStreamAuthError !== void 0 ? `upstream denied the token mid-stream: ${shim.lastStreamAuthError}` : shim.lastAuthRetry === void 0 || shim.lastAuthRetry === 0 ? "no 401 retry on the last request" : `last request hit 401 and retried ${shim.lastAuthRetry}x (5s + refresh each time)`
			},
			{
				id: "checkin",
				ok: Object.values(status.checkin.today).some((record) => record.ok),
				detail: Object.values(status.checkin.today).some((record) => record.ok) ? "checked in today" : "not checked in today"
			},
			{
				id: "quota",
				ok: status.quota.exhausted.length === 0,
				detail: status.quota.exhausted.length === 0 ? `no account is marked out of quota; window resets in ${status.quota.resetIn}` : `${status.quota.exhausted.length} account(s) out of quota` + (status.quota.exhaustedUntil === void 0 ? `; window resets in ${status.quota.resetIn}` : `; upstream says it resets at ${new Date(status.quota.exhaustedUntil).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`) + ` — ${status.quota.accounts[status.quota.exhausted[0]]?.message ?? "no upstream detail"}`
			}
		];
		json(res, 200, { report: {
			ok: checks.every((check) => check.ok),
			version: status.version,
			node: status.node,
			checks,
			llm: await deps.llmDiagnostics().catch((error) => ({
				providers: [],
				error: safeMessage(error)
			})),
			catalogUpdatedAt: status.catalogUpdatedAt,
			...status.lastDiscoveryError === void 0 ? {} : { lastDiscoveryError: status.lastDiscoveryError },
			hints: status.accounts.length === 0 ? ["sign in with a Huawei account that has DevEco access"] : []
		} });
	};
}
/** 挂载全部路由。 */
function registerDevecoStatusRoutes(ctx, deps) {
	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_STATUS_PATH,
				handler: statusHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_MODELS_PATH,
				handler: modelsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_SELECTION_PATH,
				handler: selectionHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_LOGIN_PATH,
				handler: loginStartHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_LOGIN_STATUS_PATH,
				handler: loginPollHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_TOKEN_PATH,
				handler: tokenHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_ACCOUNTS_PATH,
				handler: accountsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_CHECKIN_PATH,
				handler: checkinHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_REFRESH_MODELS_PATH,
				handler: refreshModelsHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_DOCK_PATH,
				handler: dockHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_DOCTOR_PATH,
				handler: doctorHandler(deps)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: DEVECO_QUOTA_PATH,
				handler: quotaHandler(deps)
			})
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-deveco: web routes");
}
// src/index.ts
/**
* DevEco（华为 CodeGenie MaaS）接入 DeepSeek Harness。
*
* 插件注册一个 `deveco` provider，请求经本机回环 shim 转发到 DevEco 的模型 API。
* 登录是华为账号的浏览器授权（本机回环回调），一次登录换来的 `jwtToken` 由插件自己
* 续期，`accessToken` 过期即静默刷新。
*
* 多账号：`.deveco-accounts.json` 存凭证，账号池负责轮转 —— 上游每个账号只同时放一个
* 生成，多一个号就多一份并发。模型目录来自上游 `codeGenie/modelConfig`，启动时与每小时
* 各拉一次，失败保留上一次的结果。
*
* 签到：DevEco 没有积分/领取接口（`docs/PROTOCOL.md` 第 6 节），所以这里的签到是
* **每天一次的真实体检**：逐个账号拉一次模型目录，证明凭证今天还活着，并把结果留档、
* 算连续天数。发现问题（凭证被拒）会直接把账号标成「需要重新登录」。
*
* @module dsh-deveco
*/
/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
const name = "llm-deveco";
/** provider 注册前必须先有 `llm` 服务。 */
const inject = ["llm"];
/** 拥有配置卡片的 settings 命名空间。 */
const DEVECO_SETTINGS_NS = "deveco";
function unwrapVolatileValue(value) {
	if (typeof value === "object" && value !== null && typeof value.get === "function") return value.get();
	return value;
}
function unwrapConfig(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field);
	return out;
}
const Config = z.object({
	enabledModels: z.array(z.string()).description("Model ids offered in the model pickers (empty means every model)").volatile(),
	showDock: z.boolean().default(true).description("Show the DevEco line (provider, model, today usage) under the chat input box").volatile(),
	showSidebarPanel: z.boolean().default(false).description("Show a DevEco icon in the DSH sidebar icon column").volatile(),
	showSettingsEntry: z.boolean().default(true).description("Show a DevEco entry in the left navigation of DSH Settings").volatile(),
	autoCheckin: z.boolean().default(false).description("Run the daily per-account check-in automatically (probes each account once a day and keeps the streak)").volatile(),
	maxConcurrent: z.natural().default(1).description("Concurrent upstream generations (DevEco serves one per account)").volatile(),
	maxQueue: z.natural().default(3).description("Local queue depth before requests are rejected with 429").volatile()
});
/** 签到说明（卡片直接展示，别让用户以为这是「领积分」）。 */
const CHECKIN_NOTE = "DevEco has no points or daily-reward endpoint, so this check-in is a real daily health probe: it fetches the model catalog for each account once a day, proves the credential still works, records the result and keeps a streak. A rejected credential is marked \"sign in again\".";
function settingsCompatNamespace(ctx) {
	return resolveSettingsNamespaceCompat(ctx, ctx.get("settings"), DEVECO_SETTINGS_NS);
}
function apply(ctx, rawConfig) {
	const config = unwrapConfig(rawConfig);
	/**
	* 续期失败日志。
	*
	* 宿主对插件的 info/debug 没有出口，warn 会变成系统通知 —— 一次网络抖动就弹一次窗口
	* 不行。所以失败原因写插件自己的文件，1MB 截断重来。
	*/
	const appendRefreshLog = (message) => {
		try {
			const path = devecoRefreshLogPath();
			try {
				if (statSync(path).size > 1e6) writeFileSync(path, "");
			} catch {}
			appendFileSync(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`, { mode: 384 });
		} catch {}
	};
	/** 插件是否已停用（收摊后所有定时器/回调都不再干活）。 */
	let stopped = false;
	const store = new DevecoAccountStore(devecoAccountsPath(), { log: appendRefreshLog });
	const pool = new DevecoAccountPool([], { maxConcurrent: config.maxConcurrent ?? 1 });
	const catalog = new DevecoCatalog();
	const usage = new DevecoUsageTracker({ path: devecoUsagePath() });
	const checkinLedger = new DevecoCheckinLedger({ path: devecoCheckinPath() });
	const quota = new DevecoQuotaTracker();
	let current = () => config;
	const dock = () => ({
		dock: current().showDock !== false,
		sidebar: current().showSidebarPanel === true,
		settingsEntry: current().showSettingsEntry !== false,
		autoClaim: current().autoCheckin === true
	});
	const setDock = async (patch) => {
		const settings = ctx.get("settings");
		if (settings === void 0) return false;
		await settings.update(settingsCompatNamespace(ctx), {
			...patch.dock === void 0 ? {} : { showDock: patch.dock },
			...patch.sidebar === void 0 ? {} : { showSidebarPanel: patch.sidebar },
			...patch.settingsEntry === void 0 ? {} : { showSettingsEntry: patch.settingsEntry },
			...patch.autoClaim === void 0 ? {} : { autoCheckin: patch.autoClaim }
		});
		return true;
	};
	const setEnabledModels = async (ids) => {
		const settings = ctx.get("settings");
		if (settings === void 0) return false;
		await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] });
		return true;
	};
	/** 把池与账号文档对齐（新增/删除账号后调）。 */
	const syncPool = async () => {
		const ids = await store.ids();
		pool.sync(ids);
		const summaries = await store.list();
		pool.setPaused(summaries.filter((entry) => entry.paused).map((entry) => entry.id));
		pool.setPreferred(summaries.filter((entry) => entry.pinned).map((entry) => entry.id));
	};
	/** 执行一次签到（卡片按钮与自动签到共用这一条路径）。 */
	const runCheckin$1 = async (options = {}) => {
		await syncPool();
		const outcome = await runCheckin(store, checkinLedger, {
			...options.accountId === void 0 ? {} : { accountId: options.accountId },
			force: options.force === true
		});
		for (const result of outcome.results) if (result.ok) pool.revive(result.id);
		appendRefreshLog(`checkin day=${outcome.day} ok=${String(outcome.ok)} probed=${String(outcome.probed)}: ${outcome.message}`);
		return outcome;
	};
	const loginSessions = /* @__PURE__ */ new Map();
	/**
	* 会话表兜底清理。
	*
	* 正常情况下每条会话被轮询到终态后自己删掉；这里只防「用户开了登录页又关掉」留下的
	* 悬挂条目无限堆积 —— 超过 20 条就丢最旧的。
	*/
	const pruneLogins = () => {
		if (loginSessions.size <= 20) return;
		for (const url of [...loginSessions.keys()].slice(0, loginSessions.size - 20)) {
			loginSessions.get(url)?.started.cancel();
			loginSessions.delete(url);
		}
	};
	const startLoginForCard = async (options) => {
		const started = await startLogin({ openBrowser: true });
		const session = { started };
		loginSessions.set(started.url, session);
		started.result.then(async (outcome) => {
			if (outcome.state === "done") {
				const id = await store.upsert(outcome.credential);
				await syncPool();
				pool.revive(id);
				session.outcome = {
					state: "done",
					accountId: id
				};
				appendRefreshLog(`login ok: account ${id}`);
				refreshCatalog(store, catalog).catch(() => {});
			} else {
				session.outcome = {
					state: "error",
					kind: outcome.kind,
					message: outcome.message
				};
				appendRefreshLog(`login failed (${outcome.kind}): ${outcome.message}`);
			}
		});
		pruneLogins();
		return started;
	};
	const pollLogin = (url) => {
		const session = loginSessions.get(url);
		if (session === void 0) return { state: "pending" };
		if (session.outcome === void 0) return { state: "pending" };
		const outcome = session.outcome;
		loginSessions.delete(url);
		return outcome.state === "done" ? {
			state: "done",
			accountId: outcome.accountId
		} : {
			state: "error",
			kind: outcome.kind,
			message: outcome.message
		};
	};
	/**
	* 「本该续期、但当时有请求在飞」的账号。
	*
	* 以前这种号直接跳过，等下一轮巡检（最坏 5 分钟，长回合可能跨过好几次）。现在改成
	* **挂起待办**：请求一结束（`onAccountIdle`）就立刻补刷一次 —— 既不会换掉在飞请求正在用的
	* 令牌，也不用让任何人等待。定义在 shim 之前，是因为构建 shim 时要把回调传进去。
	*/
	const pendingRefresh = /* @__PURE__ */ new Set();
	/** 补刷单个账号（尽力而为，失败留给下一轮巡检 / 401 路径）。 */
	const flushPendingRefresh = (id) => {
		if (stopped || !pendingRefresh.has(id)) return;
		if ((pool.get(id)?.activeConcurrent ?? 0) > 0) return;
		pendingRefresh.delete(id);
		store.forceRefresh(id).then((ok) => {
			ctx.logger.debug(ok ? `dsh-deveco: refreshed the deferred credential for ${id}` : `dsh-deveco: deferred refresh for ${id} did not succeed; next sweep will retry`);
		}).catch(() => {});
	};
	/** 请求结束时回调：账号空了就把挂起的续期补上。 */
	const onAccountIdle = (id) => {
		flushPendingRefresh(id);
	};
	/**
	* 「刷新额度」：重新探测每个账号现在还能不能用。
	*
	* **它不是查余额** —— 上游没有余额接口（`docs/PROTOCOL.md` 第 6 节）。它能做的就是
	* 拿一次轻量但需要鉴权的请求（`modelConfig`）去问上游「这个号现在还行吗」：
	* 成功 → 本窗口没被额度卡住；被拒且错误像是额度/限流 → 记成「额度用尽」。
	* 额度是否真的重置，只能靠时间和下一次请求来证明。
	*/
	const refreshQuota = async () => {
		await syncPool();
		const ids = await store.dispatchIds();
		const accounts = [];
		for (const id of ids) try {
			const resolved = await store.resolve(id);
			if (resolved === void 0) {
				accounts.push({
					id,
					ok: false,
					models: 0,
					message: "account needs sign-in",
					exhausted: false
				});
				continue;
			}
			const probe = await fetchModelConfig(resolved.accessToken).then((fetched) => ({
				ok: true,
				models: fetched.models.length,
				message: void 0
			}), (error) => ({
				ok: false,
				models: 0,
				message: error instanceof Error ? error.message : String(error)
			}));
			if (probe.ok) quota.noteOk(id);
			else if (probe.message !== void 0 && looksLikeQuotaExhausted(0, probe.message)) quota.noteExhausted(id, probe.message);
			accounts.push({
				id,
				ok: probe.ok,
				models: probe.models,
				...probe.message === void 0 ? {} : { message: probe.message },
				exhausted: quota.state(id)?.exhausted === true
			});
		} catch (error) {
			accounts.push({
				id,
				ok: false,
				models: 0,
				message: error instanceof Error ? error.message : String(error),
				exhausted: false
			});
		}
		const snapshot = quota.snapshot(ids);
		const ok = accounts.some((entry) => entry.ok);
		const exhausted = accounts.filter((entry) => entry.exhausted).length;
		return {
			ok,
			probed: accounts.length,
			accounts,
			snapshot,
			message: ids.length === 0 ? "no account to probe" : ok ? exhausted > 0 ? `probed ${accounts.length} account(s); ${exhausted} still marked as out of quota until ${snapshot.window.label}` : `probed ${accounts.length} account(s); all usable, quota resets in ${snapshot.resetIn}` : `probe failed: ${accounts.find((entry) => !entry.ok)?.message ?? "unknown"}`
		};
	};
	/** 手动/自动刷新目录。 */
	const refreshModels = async () => {
		await syncPool();
		const outcome = await refreshCatalog(store, catalog);
		return {
			models: catalog.current().length,
			refreshed: outcome.anySucceeded
		};
	};
	/** provider 是否真的挂上了 —— 卡片体检要能看到这一条（注册失败时它会是 false）。 */
	let providerRegistered = false;
	const shim = createDevecoShim({
		store,
		pool,
		catalog,
		usage,
		quota,
		enabledModels: () => current().enabledModels,
		onAccountIdle,
		logger: ctx.logger
	});
	ctx.inject(["webServer"], (webCtx) => {
		registerDevecoStatusRoutes(webCtx, {
			store,
			models: () => catalog.current(),
			enabledModels: () => current().enabledModels,
			setEnabledModels,
			pool: () => pool.list(),
			reviveAccount: (id) => pool.revive(id),
			usage: () => usage.snapshot(),
			checkin: () => checkinLedger.snapshot(storeIdsSnapshot()),
			runCheckin: runCheckin$1,
			quota: () => quota.snapshot(storeIdsSnapshot()),
			refreshQuota,
			dock,
			setDock,
			refreshModels,
			shimStats: () => shim.stats(),
			providerRegistered: () => providerRegistered,
			llmDiagnostics: async () => {
				try {
					const providers = ctx.llm.listProviders();
					const out = [];
					for (const provider of providers) {
						let models = 0;
						let error;
						try {
							models = (await ctx.llm.listModels(provider.id)).length;
						} catch (caught) {
							error = caught instanceof Error ? caught.message : String(caught);
						}
						out.push({
							id: provider.id,
							name: provider.name,
							models,
							...error === void 0 ? {} : { error }
						});
					}
					return { providers: out };
				} catch (caught) {
					return {
						providers: [],
						error: caught instanceof Error ? caught.message : String(caught)
					};
				}
			},
			catalogUpdatedAt: () => catalogUpdatedAt,
			lastDiscoveryError: () => lastDiscoveryError,
			startLogin: startLoginForCard,
			pollLogin,
			version: DEVECO_VERSION,
			checkinNote: CHECKIN_NOTE
		});
	});
	/** 同步快照：`checkin()` 是同步调用，而账号 id 列表是异步读的 —— 这里用池作为代理。 */
	function storeIdsSnapshot() {
		return pool.list().map((entry) => entry.id);
	}
	installSettingsSectionCompat(ctx, DEVECO_SETTINGS_NS, Config, config, {
		setSource(source) {
			current = () => unwrapConfig(source());
			armAutoCheckin();
		},
		onChange() {
			armAutoCheckin();
		}
	});
	const CATALOG_REFRESH_MS = 36e5;
	/** 目录空时的重试（指数退避，封顶 5 分钟）。 */
	const CATALOG_EMPTY_RETRY_MS = 6e4;
	const CATALOG_EMPTY_RETRY_MAX_MS = 3e5;
	let discoveryTimer;
	let emptyStreak = 0;
	const abort = new AbortController();
	/** 目录最后一次成功刷新的时刻（0 = 从没成功过）。卡片/体检用它判断「看到的模型是不是旧的」。 */
	let catalogUpdatedAt = 0;
	/** 最近一次发现失败的原因（给体检用，别让用户只能靠猜）。 */
	let lastDiscoveryError;
	const discoverLoop = async () => {
		if (stopped) return;
		try {
			await syncPool();
			const outcome = await refreshCatalog(store, catalog, abort.signal);
			catalogUpdatedAt = outcome.anySucceeded ? Date.now() : catalogUpdatedAt;
			lastDiscoveryError = outcome.anySucceeded ? void 0 : outcome.accounts.flatMap((account) => account.errors).slice(0, 3).join(" | ") || "no account";
			if (outcome.anySucceeded) ctx.logger.debug(`dsh-deveco: model catalog refreshed (${outcome.models.length} models)`);
			else if ((await store.ids()).length > 0) ctx.logger.debug("dsh-deveco: model discovery found nothing usable; keeping the current catalog");
		} catch (error) {
			lastDiscoveryError = error instanceof Error ? error.message : String(error);
			ctx.logger.debug("dsh-deveco: model discovery failed; keeping the current catalog", error);
		}
		if (stopped) return;
		let delay;
		if (catalog.current().length === 0) {
			delay = Math.min(CATALOG_EMPTY_RETRY_MS * 2 ** emptyStreak, CATALOG_EMPTY_RETRY_MAX_MS);
			emptyStreak += 1;
		} else {
			emptyStreak = 0;
			delay = CATALOG_REFRESH_MS;
		}
		discoveryTimer = setTimeout(() => void discoverLoop(), delay);
		discoveryTimer.unref?.();
	};
	/**
	* 每 5 分钟扫一遍账号，把「剩余寿命低于提前量（默认 10 分钟）」的 accessToken 提前续掉。
	*
	* 为什么是 5 分钟：accessToken 只有 30 分钟，提前量 10 分钟，也就是每张令牌有一个
	* 20 分钟的「可续期窗口」。扫描间隔必须明显小于这个窗口，才能保证每个账号在一张令牌
	* 过期前至少被扫到一次 —— 20 分钟的扫描间隔刚好卡在窗口边界上，抖动一下就会滑过去。
	*
	* 这一轮只是「没人聊天时也别让凭证裸奔到过期」；真正的第一道防线是
	* `auth.ts` 的 `accessToken()`：**每次取号发请求前**都会检查剩余寿命，不足 10 分钟就先刷新。
	*/
	const KEEP_ALIVE_INTERVAL_MS = 3e5;
	let keepAliveTimer;
	const keepAliveLoop = async () => {
		if (stopped) return;
		try {
			const busy = pool.list().filter((entry) => entry.activeConcurrent > 0).map((entry) => entry.id);
			for (const id of busy) pendingRefresh.add(id);
			const outcome = await store.keepAlive({ skip: (id) => (pool.get(id)?.activeConcurrent ?? 0) > 0 });
			for (const id of [...pendingRefresh]) if (!busy.includes(id)) pendingRefresh.delete(id);
			if (outcome.refreshed > 0) ctx.logger.debug(`dsh-deveco: refreshed ${outcome.refreshed} access token(s)`);
			if (outcome.needsLogin.length > 0) ctx.logger.debug(`dsh-deveco: ${outcome.needsLogin.length} account(s) need a fresh sign-in`);
		} catch (error) {
			ctx.logger.debug("dsh-deveco: credential keep-alive failed; will retry", error);
		}
		if (stopped) return;
		keepAliveTimer = setTimeout(() => void keepAliveLoop(), KEEP_ALIVE_INTERVAL_MS);
		keepAliveTimer.unref?.();
	};
	/** 首次延迟：别和启动瞬间的目录请求抢上游。 */
	const AUTO_CHECKIN_FIRST_DELAY_MS = 3e4;
	/** 之后每 6 小时看一次（一天只签一次，重复的是幂等跳过）。 */
	const AUTO_CHECKIN_INTERVAL_MS = 216e5;
	let autoCheckinTimer;
	const autoCheckinLoop = async () => {
		if (stopped) return;
		if (!dock().autoClaim) {
			autoCheckinTimer = void 0;
			return;
		}
		try {
			const outcome = await runCheckin$1();
			if (outcome.probed > 0) ctx.logger.debug(`dsh-deveco: auto check-in: ${outcome.message}`);
		} catch (error) {
			ctx.logger.debug("dsh-deveco: auto check-in failed; will retry next round", error);
		}
		if (stopped) return;
		autoCheckinTimer = setTimeout(() => void autoCheckinLoop(), AUTO_CHECKIN_INTERVAL_MS);
		autoCheckinTimer.unref?.();
	};
	const armAutoCheckin = () => {
		if (stopped) return;
		if (!dock().autoClaim) {
			if (autoCheckinTimer !== void 0) clearTimeout(autoCheckinTimer);
			autoCheckinTimer = void 0;
			return;
		}
		if (autoCheckinTimer !== void 0) return;
		autoCheckinTimer = setTimeout(() => void autoCheckinLoop(), AUTO_CHECKIN_FIRST_DELAY_MS);
		autoCheckinTimer.unref?.();
	};
	usage.load().catch(() => {});
	ctx.effect(() => () => {
		stopped = true;
		abort.abort();
		for (const timer of [
			discoveryTimer,
			keepAliveTimer,
			autoCheckinTimer
		]) if (timer !== void 0) clearTimeout(timer);
		for (const session of loginSessions.values()) session.started.cancel();
		loginSessions.clear();
		usage.flush().catch(() => {});
		shim.close().catch(() => {});
	});
	shim.ready.then(async () => {
		if (stopped) return;
		await syncPool();
		await Promise.race([(async () => {
			try {
				const outcome = await refreshCatalog(store, catalog);
				if (outcome.anySucceeded) catalogUpdatedAt = Date.now();
				else lastDiscoveryError = outcome.accounts.flatMap((a) => a.errors).slice(0, 3).join(" | ") || "no account";
			} catch (error) {
				lastDiscoveryError = error instanceof Error ? error.message : String(error);
			}
		})(), new Promise((resolve) => {
			setTimeout(resolve, 25e3).unref?.();
		})]);
		if (stopped) return;
		ctx.logger.debug(`dsh-deveco: first discovery done (${catalog.current().length} model(s) known)`);
		discoverLoop();
		keepAliveLoop();
		armAutoCheckin();
		const deveco = createDevecoAdapter({
			shim,
			catalog,
			enabledModels: () => current().enabledModels,
			resolveAttachments: () => ctx.get("attachments")
		});
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([DEVECO_PROVIDER], deveco.adapter);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: DEVECO_PROVIDER,
				displayName: "DevEco",
				settingsNs: settingsCompatNamespace(ctx),
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
		}
		providerRegistered = true;
		ctx.logger.debug(`dsh-deveco: provider "${DEVECO_PROVIDER}" registered (shim on ${shim.baseUrl()})`);
	}).catch((error) => {
		ctx.logger.error("dsh-deveco: loopback shim failed to start; provider not registered", error);
	});
}
export { CHECKIN_NOTE, Config, DEVECO_PROVIDER, DEVECO_SETTINGS_NS, DEVECO_VERSION, DevecoAccountPool, DevecoAccountStore, DevecoCatalog, DevecoCheckinLedger, DevecoQueueGate, DevecoUsageTracker, FALLBACK_PARAMS, HIDDEN_MODELS, apply, createDevecoAdapter, createDevecoShim, devecoAccountsPath, devecoCheckinPath, devecoUsagePath, discoverModels, filterEnabledModels, inject, mergeModelLists, name, parseJwtPayload, refreshCatalog, runCheckin, startLogin };
