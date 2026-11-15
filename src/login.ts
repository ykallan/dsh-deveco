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

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  ACCESS_TOKEN_TTL_MS,
  BROWSER_USER_AGENT,
  CONTROL_TIMEOUT_MS,
  DEVECO_APP_ID,
  DEVECO_AUTH_URL,
  DEVECO_CALLBACK_PATH,
  DEVECO_CALLBACK_PORTS,
  DEVECO_CHINA_SITE_ID,
  DEVECO_FAILED_URL,
  DEVECO_JWT_TOKEN_URL,
  DEVECO_SUCCESS_URL,
  DEVECO_TEMP_TOKEN_URL,
  LOGIN_TIMEOUT_MS,
} from './config.ts'
import {
  type DevecoCredential,
  type DevecoTokenCheckResponse,
  parseJwtPayload,
  parseRealName,
  requestTokenRefresh,
} from './auth.ts'

/** 登录失败的分类，卡片按它给不同的文案。 */
export type LoginFailureKind = 'cancelled' | 'region' | 'timeout' | 'network' | 'exchange' | 'server'

/** 登录结果（成功/失败都以 result 的形式 resolve，不 reject）。 */
export type LoginOutcome =
  | { state: 'done'; credential: DevecoCredential }
  | { state: 'error'; kind: LoginFailureKind; message: string }

/** 带分类的登录错误。 */
export class LoginError extends Error {
  readonly kind: LoginFailureKind

  constructor(kind: LoginFailureKind, message: string) {
    super(message)
    this.name = 'LoginError'
    this.kind = kind
  }
}

/** 启动登录后拿到的东西：地址、端口，以及最终结果的 promise。 */
export interface StartedLogin {
  url: string
  port: number
  result: Promise<LoginOutcome>
  /** 主动收摊（插件停用/用户取消时）。 */
  cancel: () => void
}

/** 回调服务收到的参数。 */
interface CallbackPayload {
  code: string
  tempToken: string | null
  siteId: string | null
  quit: string | null
}

/**
 * 只绑 loopback 的一次性回调服务。
 *
 * 一个实例只服务一次登录：`code` 对得上的第一个回调即 resolve，其它投递一律忽略。
 */
class LoginCallbackServer {
  private server: Server | undefined
  private port = 0
  private readonly secret: string
  private settle: ((payload: CallbackPayload) => void) | undefined
  private reject: ((error: Error) => void) | undefined
  private payload: Promise<CallbackPayload> | undefined
  private closed = false

  constructor(secret: string) {
    this.secret = secret
  }

  /** 依次尝试候选端口，绑定成功即返回真实端口。 */
  async start(): Promise<number> {
    this.payload ??= new Promise<CallbackPayload>((resolve, reject) => {
      this.settle = resolve
      this.reject = reject
    })
    for (const port of DEVECO_CALLBACK_PORTS) {
      const bound = await this.tryListen(port)
      if (bound !== undefined) {
        this.port = bound
        return bound
      }
    }
    throw new LoginError('server', `could not bind any callback port (tried ${DEVECO_CALLBACK_PORTS.join(', ')})`)
  }

  private tryListen(port: number): Promise<number | undefined> {
    return new Promise<number | undefined>(resolve => {
      const server = createServer((req, res) => this.handle(req, res))
      server.once('error', () => {
        server.close()
        resolve(undefined)
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const address = server.address() as AddressInfo | null
        resolve(address?.port ?? port)
      })
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (url.pathname !== DEVECO_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    if (req.method === 'GET') {
      this.accept(url.searchParams, res)
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
        if (body.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => this.accept(new URLSearchParams(body), res))
      return
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed')
  }

  private accept(params: URLSearchParams, res: ServerResponse): void {
    const code = params.get('code')
    if (code === null || code !== this.secret) {
      // 不是本次登录的回调（可能是别的本地进程乱投递）：拒绝，但继续等真正的回调。
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
      return
    }
    const payload: CallbackPayload = {
      code,
      tempToken: params.get('tempToken'),
      siteId: params.get('siteId'),
      quit: params.get('quit'),
    }
    const failed = payload.quit === 'true' || payload.quit === 'access_denied'
    res.writeHead(302, { Location: failed ? DEVECO_FAILED_URL : DEVECO_SUCCESS_URL })
    res.end()
    const settle = this.settle
    this.settle = undefined
    settle?.(payload)
  }

  /** 等一次回调（带总预算）。 */
  async waitForCallback(timeoutMs = LOGIN_TIMEOUT_MS): Promise<CallbackPayload> {
    const payload = this.payload
    if (payload === undefined) throw new LoginError('server', 'callback server was not started')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        payload,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new LoginError('timeout', 'timed out waiting for the browser to finish signing in'))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 收摊。可重复调用。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const reject = this.reject
    this.settle = undefined
    this.reject = undefined
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        // 浏览器可能还挂着 keep-alive 连接，别让 close 无限等。
        const timer = setTimeout(resolve, 500)
        timer.unref?.()
      })
    }
    reject?.(new LoginError('cancelled', 'login cancelled'))
  }
}

/** 生成 32 位十六进制客户端密钥。 */
export function newClientSecret(): string {
  return randomUUID().replace(/-/g, '')
}

/** 拼登录页地址。 */
export function buildLoginUrl(port: number, secret: string): string {
  return `${DEVECO_AUTH_URL}?port=${port}&appid=${DEVECO_APP_ID}&code=${secret}`
}

/** 打开登录页的平台命令（Windows 上 URL 必须加引号，否则 `&` 会被命令解释器切开）。 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[]; shell: boolean } {
  if (platform === 'win32') return { command: `start "" "${url}"`, args: [], shell: true }
  if (platform === 'darwin') return { command: 'open', args: [url], shell: false }
  return { command: 'xdg-open', args: [url], shell: false }
}

/** 把 URL 交给系统默认浏览器。失败不抛：卡片会把地址显示出来让用户自己点。 */
export function openBrowser(url: string): boolean {
  try {
    const { command, args, shell } = browserOpenCommand(process.platform, url)
    const child = spawn(command, args, { shell, detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** 登录页必须是官方域名 https（防止配置/输入把用户带到别处）。 */
export function assertOfficialAuthUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cn.devecostudio.huawei.com') {
    throw new LoginError('server', `refusing to open an unexpected sign-in URL: ${parsed.origin}`)
  }
}

/**
 * `tempToken` → `jwtToken`。
 *
 * 响应体是**纯文本 JWT**（不是 JSON），所以 `text()` 后 `trim()`；上游偶尔把 `&...`
 * 粘在 tempToken 尾巴上，先切掉。
 */
export async function exchangeTempToken(tempToken: string, signal?: AbortSignal): Promise<string> {
  const token = tempToken.split('&')[0] ?? ''
  if (token === '') throw new LoginError('exchange', 'the callback carried an empty tempToken')
  const url = new URL(DEVECO_TEMP_TOKEN_URL)
  url.searchParams.set('tempToken', token)
  url.searchParams.set('site', 'CN')
  url.searchParams.set('version', '1.0.0')
  url.searchParams.set('appid', DEVECO_APP_ID)
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': BROWSER_USER_AGENT, 'accept-language': 'zh-CN' },
    signal: signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new LoginError('exchange', `jwtToken exchange failed with HTTP ${response.status}`)
  }
  const jwtToken = (await response.text()).trim()
  if (jwtToken.split('.').length !== 3) {
    throw new LoginError('exchange', 'upstream returned something that is not a jwtToken')
  }
  return jwtToken
}

/** 把 jwtToken 换成一个装好的凭证；失败抛 `LoginError`。 */
export async function credentialFromJwtToken(
  jwtToken: string,
  options: { label?: string; signal?: AbortSignal } = {},
): Promise<DevecoCredential> {
  const payload = parseJwtPayload(jwtToken)
  const refreshed = await requestTokenRefresh(jwtToken, options.signal)
  if (refreshed === undefined) {
    throw new LoginError('exchange', 'the jwtToken could not be exchanged for an access token')
  }
  const now = Date.now()
  return {
    jwtToken,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_MS,
    ...refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken },
    ...payload.userId === undefined ? {} : { userId: payload.userId },
    ...payload.userName === undefined ? {} : { userName: payload.userName },
    ...payload.nationalCode === undefined ? {} : { nationalCode: payload.nationalCode },
    ...payload.isRealName === undefined ? {} : { isRealName: payload.isRealName },
    ...refreshed.isRealName === undefined ? {} : { isRealName: refreshed.isRealName },
    ...options.label === undefined ? {} : { label: options.label },
    storedAt: now,
    lastLoginAt: now,
  }
}

/** `jwToken/check` 的完整响应（诊断用；登录路径只关心状态）。 */
export async function checkJwtToken(jwtToken: string, signal?: AbortSignal): Promise<DevecoTokenCheckResponse | undefined> {
  try {
    const response = await fetch(DEVECO_JWT_TOKEN_URL, {
      headers: { refresh: 'false', jwtToken, 'accept-language': 'zh-CN' },
      signal: signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.json() as DevecoTokenCheckResponse
  } catch {
    return undefined
  }
}

/** 校验 `realName` 字段的宽松形态（上游给布尔或字符串）。 */
export { parseRealName }

/**
 * 起一次登录。
 *
 * 端口绑定是同步的一小步（毫秒级），先等它完成才拿得到真正要展示给用户的 URL。
 * 之后的等待都在 `result` 上，卡片可以轮询它，不必挂着一个长请求。
 */
export async function startLogin(options: { openBrowser?: boolean } = {}): Promise<StartedLogin> {
  const secret = newClientSecret()
  const server = new LoginCallbackServer(secret)
  const port = await server.start()
  const url = buildLoginUrl(port, secret)
  assertOfficialAuthUrl(url)
  if (options.openBrowser !== false) openBrowser(url)

  const result = (async (): Promise<LoginOutcome> => {
    try {
      const payload = await server.waitForCallback()
      if (payload.quit === 'true' || payload.quit === 'access_denied') {
        throw new LoginError(
          'cancelled',
          payload.quit === 'access_denied'
            ? 'access denied on the DevEco sign-in page'
            : 'sign-in was cancelled in the browser',
        )
      }
      if (payload.tempToken === null || payload.tempToken === '') {
        throw new LoginError('exchange', 'the callback carried no tempToken')
      }
      if (payload.siteId !== null && payload.siteId !== DEVECO_CHINA_SITE_ID) {
        throw new LoginError('region', 'only China-site accounts are supported (siteId must be 1)')
      }
      const jwtToken = await exchangeTempToken(payload.tempToken)
      const credential = await credentialFromJwtToken(jwtToken)
      const nationalCode = (credential.nationalCode ?? '').trim().toUpperCase()
      if (nationalCode !== '' && nationalCode !== 'CN') {
        throw new LoginError('region', 'only China-region (CN) accounts are supported')
      }
      return { state: 'done', credential }
    } catch (error: unknown) {
      const kind = error instanceof LoginError ? error.kind : 'network'
      return { state: 'error', kind, message: error instanceof Error ? error.message : String(error) }
    } finally {
      await server.close()
    }
  })()

  return {
    url,
    port,
    result,
    cancel: () => {
      void server.close()
    },
  }
}
