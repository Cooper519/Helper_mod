import { UserError } from "../user-error";
import { Agent, request } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Asset, Provider, SourceConfig } from "./types";

const hosts = {
  github: [
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ],
  gitee: ["gitee.com", "api.gitee.com", "foruda.gitee.com"],
};
export type Access = { origin: string; allowed: string[]; token?: string };
export interface ProxyChoice {
  url: URL;
  fromSystem: boolean;
}

function cleanSecret(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\r\n\x00]/.test(trimmed))
    throw new UserError(`${label}包含换行或非法字符，请重新粘贴`);
  return trimmed;
}

export function vpsAccess(source: SourceConfig): Access {
  const rawUrl = source.vpsUrl?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserError("请配置 VPS HTTPS 地址");
  }
  const token = cleanSecret(source.vpsToken, "VPS 访问密钥");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !token
  )
    throw new UserError("需要 HTTPS 订阅地址和密钥，密钥不能放在 URL 中");
  if (url.pathname !== "/" && url.pathname !== "/manifest.json")
    throw new UserError(
      "请填写订阅站点根地址或 /manifest.json，不要填写仓库或附件链接",
    );
  return { origin: url.origin, allowed: [url.origin], token };
}

/** 静默调用系统凭据助手；不在命令参数、终端或日志中展开凭据。 */
export function getGcmToken(provider: Provider): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-c", "credential.interactive=false", "credential", "fill"],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
        },
      },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill(), 4500);
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      if (output.length + s.length <= 32768) output += s;
      else child.kill();
    });
    const finish = (token?: string) => {
      clearTimeout(timeout);
      resolve(token);
    };
    child.on("error", () => finish());
    child.on("close", (c) =>
      finish(
        c === 0
          ? /^password=([^\r\n]+)$/m.exec(output.replace(/\r/g, ""))?.[1]
          : undefined,
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(`protocol=https\nhost=${provider}.com\n\n`);
  });
}

export type AuthCandidate = { access: Access } | { error: UserError };

/** 按规格 A8 惰性构造凭据候选：优先本机 GCM，仅在失效时才触碰后续备用令牌，避免未使用的坏令牌阻断有效凭据。 */
export async function providerCandidates(
  source: SourceConfig,
  provider: Provider,
  privateRepo: boolean,
): Promise<AuthCandidate[]> {
  const base: Access = {
    origin:
      provider === "github" ? "https://api.github.com" : "https://gitee.com",
    allowed: hosts[provider].map((h) => "https://" + h),
  };
  if (!privateRepo) return [{ access: base }];
  const entries: [string | undefined, string][] = [
    [await getGcmToken(provider), "Git 凭据"],
    [
      provider === "github" ? source.githubToken : source.giteeToken,
      "只读 Token",
    ],
    [
      provider === "github"
        ? process.env.GITHUB_TOKEN
        : process.env.GITEE_TOKEN,
      "环境变量 Token",
    ],
  ];
  const seen = new Set<string>();
  const out: AuthCandidate[] = [];
  for (const [raw, label] of entries) {
    if (!raw) continue;
    try {
      const token = cleanSecret(raw, label);
      if (token && !seen.has(token)) {
        seen.add(token);
        out.push({ access: { ...base, token } });
      }
    } catch (err) {
      if (err instanceof UserError) out.push({ error: err });
      else throw err;
    }
  }
  return out.length ? out : [{ access: base }];
}

export async function providerAccess(
  source: SourceConfig,
  provider: Provider,
  privateRepo: boolean,
): Promise<Access> {
  const candidates = await providerCandidates(source, provider, privateRepo);
  const valid = candidates.find(
    (c): c is { access: Access } => "access" in c,
  );
  if (valid) return valid.access;
  const firstErr = candidates.find(
    (c): c is { error: UserError } => "error" in c,
  );
  if (firstErr) throw firstErr.error;
  return {
    origin:
      provider === "github" ? "https://api.github.com" : "https://gitee.com",
    allowed: hosts[provider].map((h) => "https://" + h),
  };
}

export function isAuthFallbackError(err: unknown): boolean {
  return (
    err instanceof UserError &&
    /^更新源返回 HTTP (401|403|404)$/.test(err.message)
  );
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.startsWith("127.");
}

export function isProxyBypassed(hostname: string, bypassRaw: string): boolean {
  if (!bypassRaw.trim()) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  for (const raw of bypassRaw.split(/[;,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry === "<local>") {
      if (!host.includes(".") || isLoopbackHost(host)) return true;
      continue;
    }
    const pattern = entry.replace(/:\d+$/, "");
    if (pattern.includes("*")) {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      if (new RegExp(`^${escaped}$`, "i").test(host)) return true;
      continue;
    }
    const bare = pattern.replace(/^\./, "");
    if (host === bare || host.endsWith("." + bare)) return true;
  }
  return false;
}

function parseProxyAddress(raw: string): URL | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (!["http:", "https:", "socks:", "socks5:", "socks5h:"].includes(u.protocol))
      return undefined;
    if (!u.hostname) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

export function parseWindowsProxy(
  regOutput: string,
): { proxy?: URL; bypass: string } {
  const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput);
  if (!enabledMatch || Number.parseInt(enabledMatch[1], 16) === 0)
    return { bypass: "" };
  const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(regOutput);
  const bypassMatch = /ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i.exec(regOutput);
  const server = serverMatch?.[1]?.trim() ?? "";
  const bypass = bypassMatch?.[1]?.trim() ?? "";
  if (!server) return { bypass };
  if (server.includes("=")) {
    const byScheme = new Map<string, string>();
    for (const part of server.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        byScheme.set(
          part.slice(0, idx).trim().toLowerCase(),
          part.slice(idx + 1).trim(),
        );
      }
    }
    const chosen =
      byScheme.get("https") ??
      byScheme.get("http") ??
      (byScheme.get("socks") ? `socks5://${byScheme.get("socks")}` : undefined);
    return { proxy: chosen ? parseProxyAddress(chosen) : undefined, bypass };
  }
  return { proxy: parseProxyAddress(server), bypass };
}

export function parseMacProxy(
  scutilOutput: string,
): { proxy?: URL; bypass: string } {
  const field = (name: string) =>
    new RegExp(`^\\s*${name}\\s*:\\s*([^\\r\\n]+)`, "m")
      .exec(scutilOutput)?.[1]
      ?.trim();
  const exceptions: string[] = [];
  const listMatch = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/m.exec(
    scutilOutput,
  );
  if (listMatch) {
    for (const line of listMatch[1].split(/\r?\n/)) {
      const m = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
      if (m) exceptions.push(m[1]);
    }
  }
  const bypass = exceptions.join(",");
  const pick = (enableKey: string, hostKey: string, portKey: string, scheme: string) => {
    if (field(enableKey) !== "1") return undefined;
    const host = field(hostKey);
    const port = field(portKey);
    if (!host || !port) return undefined;
    return parseProxyAddress(`${scheme}://${host}:${port}`);
  };
  const proxy =
    pick("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http") ??
    pick("HTTPEnable", "HTTPProxy", "HTTPPort", "http") ??
    pick("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5");
  return { proxy, bypass };
}

let cachedSystemProxy:
  | { expires: number; value: { proxy?: URL; bypass: string } }
  | undefined;

export function resetProxyCache() {
  cachedSystemProxy = undefined;
}

async function querySystemProxy(): Promise<{ proxy?: URL; bypass: string }> {
  if (process.env.IELTS_HELPER_NO_SYSTEM_PROXY === "1") return { bypass: "" };
  const now = Date.now();
  if (cachedSystemProxy && now < cachedSystemProxy.expires)
    return cachedSystemProxy.value;
  let value: { proxy?: URL; bypass: string } = { bypass: "" };
  if (process.platform === "win32") {
    const out = await new Promise<string>((resolve) =>
      execFile(
        "reg",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ],
        { windowsHide: true, timeout: 1500 },
        (err, stdout) => resolve(err ? "" : stdout),
      ),
    );
    value = parseWindowsProxy(out);
  } else if (process.platform === "darwin") {
    const out = await new Promise<string>((resolve) =>
      execFile(
        "scutil",
        ["--proxy"],
        { timeout: 1500 },
        (err, stdout) => resolve(err ? "" : stdout),
      ),
    );
    value = parseMacProxy(out);
  }
  cachedSystemProxy = { expires: now + 15000, value };
  return value;
}

export async function resolveProxy(target: URL): Promise<ProxyChoice | undefined> {
  const envRaw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (envRaw) {
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
    if (isProxyBypassed(target.hostname, noProxy)) return undefined;
    const url = parseProxyAddress(envRaw);
    return url ? { url, fromSystem: false } : undefined;
  }
  if (isLoopbackHost(target.hostname)) return undefined;
  const sys = await querySystemProxy();
  if (!sys.proxy || isProxyBypassed(target.hostname, sys.bypass))
    return undefined;
  return { url: sys.proxy, fromSystem: true };
}

export function connectHttpProxy(
  proxy: URL,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
    };
    if (proxy.username || proxy.password) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(cred, "utf8").toString("base64");
    }
    const req = (proxy.protocol === "https:" ? request : httpRequest)({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    req.setTimeout(15000, () => req.destroy(new UserError("连接代理超时")));
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new UserError(
            `代理拒绝连接（HTTP ${res.statusCode}），请检查系统代理设置`,
          ),
        );
        return;
      }
      resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

/** 单监听器顺序缓冲 SOCKS5 握手字节，避免对流动中的 socket 反复 unshift 导致后续字节卡死。 */
class SocksReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended: Error | undefined;
  private waiter?: {
    count: number;
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
  };
  private readonly onData = (chunk: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.flush();
  };
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () =>
    this.fail(new UserError("SOCKS5 代理连接提前关闭"));

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  private flush() {
    if (!this.waiter) return;
    if (this.buf.length >= this.waiter.count) {
      const { count, resolve } = this.waiter;
      this.waiter = undefined;
      const out = this.buf.subarray(0, count);
      this.buf = this.buf.subarray(count);
      resolve(out);
      return;
    }
    if (this.ended) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(this.ended);
    }
  }

  private fail(err: Error) {
    if (!this.ended) this.ended = err;
    this.flush();
  }

  read(count: number): Promise<Buffer> {
    if (this.buf.length >= count) {
      const out = this.buf.subarray(0, count);
      this.buf = this.buf.subarray(count);
      return Promise.resolve(out);
    }
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.waiter = { count, resolve, reject };
    });
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    if (this.buf.length) {
      this.socket.pause();
      this.socket.unshift(this.buf);
      this.buf = Buffer.alloc(0);
    }
  }
}

export async function connectSocks5Proxy(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15000,
): Promise<net.Socket> {
  const proxyPort = Number(proxy.port) || 1080;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: proxy.hostname, port: proxyPort });
    const onTimeout = () => s.destroy(new UserError("连接代理超时"));
    s.setTimeout(timeoutMs, onTimeout);
    s.once("connect", () => {
      s.off("timeout", onTimeout);
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
  const reader = new SocksReader(socket);
  const handshakeTimer = setTimeout(() => {
    socket.destroy(new UserError("SOCKS5 代理握手超时"));
  }, timeoutMs);
  try {
    const hasAuth = Boolean(proxy.username || proxy.password);
    socket.write(
      hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]),
    );
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff)
      throw new UserError("SOCKS5 代理认证方式不支持");
    if (greeting[1] === 0x02) {
      const user = Buffer.from(decodeURIComponent(proxy.username), "utf8");
      const pass = Buffer.from(decodeURIComponent(proxy.password), "utf8");
      if (user.length > 255 || pass.length > 255)
        throw new UserError("SOCKS5 代理凭据过长");
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ]),
      );
      const authRes = await reader.read(2);
      if (authRes[1] !== 0x00) throw new UserError("SOCKS5 代理认证失败");
    }
    const hostBuf = Buffer.from(targetHost, "utf8");
    if (hostBuf.length > 255) throw new UserError("目标主机名过长");
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf,
      ]),
    );
    const head = await reader.read(4);
    if (head[0] !== 0x05 || head[1] !== 0x00)
      throw new UserError("SOCKS5 代理转发目标失败");
    if (head[3] === 0x01) await reader.read(6);
    else if (head[3] === 0x04) await reader.read(18);
    else if (head[3] === 0x03) {
      const len = (await reader.read(1))[0];
      await reader.read(len + 2);
    } else throw new UserError("SOCKS5 代理响应无效");
    reader.detach();
    socket.setTimeout(0);
    return socket;
  } catch (err) {
    reader.detach();
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(handshakeTimer);
  }
}

/** 经代理建立端到端 TLS 隧道；系统代理残留未启动时自动回落直连。 */
function createProxyAgent(choice: ProxyChoice): Agent {
  const agent = new Agent({ keepAlive: false });
  (
    agent as unknown as {
      createConnection(
        options: tls.ConnectionOptions & { host?: string; port?: number | string },
        cb: (err: Error | null, socket?: tls.TLSSocket) => void,
      ): void;
    }
  ).createConnection = (options, cb) => {
    const targetHost = String(options.servername || options.host || "");
    const targetPort = Number(options.port) || 443;
    const dial =
      choice.url.protocol.startsWith("socks")
        ? connectSocks5Proxy(choice.url, targetHost, targetPort)
        : connectHttpProxy(choice.url, targetHost, targetPort);
    dial
      .then((socket) => {
        const tlsSocket = tls.connect({
          ...options,
          socket,
          servername: targetHost,
        });
        cb(null, tlsSocket);
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (choice.fromSystem && err?.code === "ECONNREFUSED") {
          const direct = tls.connect({
            ...options,
            host: targetHost,
            port: targetPort,
            servername: targetHost,
          });
          cb(null, direct);
          return;
        }
        cb(
          err instanceof UserError
            ? err
            : new UserError("代理连接失败，请检查系统代理地址与端口"),
        );
      });
  };
  return agent;
}

function networkError(err: unknown): UserError {
  if (err instanceof UserError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new UserError("无法解析更新源域名，请检查网络或系统代理");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT")
    return new UserError("连接更新源超时，请检查网络或系统代理");
  if (code === "ECONNREFUSED")
    return new UserError("更新源或代理拒绝连接，请检查地址与代理端口");
  if (code === "ECONNRESET" || code === "EPIPE")
    return new UserError("更新源连接中断，请检查网络或系统代理");
  if (code === "ERR_INVALID_CHAR")
    return new UserError("请求头含非法字符，请检查密钥是否有多余换行或空格");
  if (
    code.startsWith("ERR_TLS_") ||
    [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_NOT_YET_VALID",
    ].includes(code)
  )
    return new UserError("TLS 证书校验失败，请检查系统时间或代理证书");
  return new UserError("更新源连接失败，请检查网络、代理与证书");
}

/** 只识别订阅服务约定的错误码；代理的 HTML 和未知正文不进入提示或日志。 */
async function manifest502(res: IncomingMessage): Promise<UserError> {
  try {
    if (res.headers["content-type"]?.startsWith("application/json")) {
      let body = "";
      for await (const chunk of res) {
        if (body.length + chunk.length > 1024) break;
        body += chunk.toString("utf8");
      }
      if (JSON.parse(body)?.error === "upstream_unavailable")
        return new UserError(
          "订阅返回 HTTP 502：上游清单不可用，请维护者检查三类发布附件和私仓读取权限",
        );
    }
  } catch {
    // 网关也可能返回截断或非 JSON 的错误页。
  } finally {
    res.destroy();
  }
  return new UserError(
    "订阅返回 HTTP 502：请检查 /health；若正常，请维护者核对 VPS 源站清单和上游发布",
  );
}

/** 每次跳转重新检查完整 HTTPS origin；认证只发给原始站，跨站后不再恢复。 */
export async function openStream(
  input: string,
  access: Access,
  accept: string,
  refresh = false,
  method: "GET" | "HEAD" = "GET",
  extraHeaders?: Record<string, string>,
): Promise<IncomingMessage> {
  let url: URL;
  try {
    url = new URL(input, access.origin);
  } catch {
    throw new UserError("下载地址无效");
  }
  let token =
    access.token && url.origin === access.origin ? access.token : undefined;
  for (let n = 0; n <= 5; n++) {
    if (
      url.protocol !== "https:" ||
      !access.allowed.includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new UserError("拒绝非受信 HTTPS 下载站点");
    const proxy = await resolveProxy(url);
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      let req: ReturnType<typeof request>;
      try {
        req = request(
          url,
          {
            method,
            ...(proxy ? { agent: createProxyAgent(proxy) } : {}),
            headers: {
              "User-Agent": "ielts-helper-plugin",
              Accept: accept,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(refresh ? { "Cache-Control": "no-cache" } : {}),
              ...(extraHeaders ?? {}),
            },
          },
          resolve,
        );
      } catch (err) {
        reject(networkError(err));
        return;
      }
      req.setTimeout(30000, () => req.destroy(new UserError("连接超时")));
      req.on("error", (err) => reject(networkError(err)));
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
      const location = res.headers.location;
      res.destroy();
      if (!location) throw new UserError("下载源未提供跳转目标");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new UserError("下载跳转地址无效");
      }
      if (next.origin !== url.origin) token = undefined;
      url = next;
      continue;
    }
    const okStatus = extraHeaders?.Range
      ? res.statusCode === 206 || res.statusCode === 200
      : res.statusCode === 200;
    if (!okStatus) {
      if (input === "/manifest.json" && res.statusCode === 502)
        throw await manifest502(res);
      res.destroy();
      throw new UserError(`更新源返回 HTTP ${res.statusCode}`);
    }
    return res;
  }
  throw new UserError("下载跳转次数过多");
}

export async function text(
  input: string,
  access: Access,
  accept = "application/json",
  refresh = false,
): Promise<string> {
  const response = await openStream(input, access, accept, refresh),
    chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        response.destroy();
        throw new UserError("发布元数据超出限制");
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    throw networkError(err);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function checkAsset(a: Asset) {
  if (
    !a ||
    !Number.isSafeInteger(a.size) ||
    a.size < 0 ||
    !/^\w/.test(a.sha256) ||
    !/^[a-f\d]{64}$/i.test(a.sha256) ||
    typeof a.url !== "string"
  )
    throw new UserError("清单附件缺少大小、地址或 SHA-256");
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest("hex");
}

/** 大附件流式下载：保留全量 SHA-256 与大小校验；中途断流按磁盘已落盘字节 Range 续传。 */
export async function download(a: Asset, access: Access, file: string) {
  checkAsset(a);
  let hash = createHash("sha256");
  let resumed = false;
  let diskBytes = 0;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const resuming = attempt > 0 && diskBytes > 0 && diskBytes < a.size;
    let res: IncomingMessage;
    try {
      res = await openStream(
        a.url,
        access,
        "application/octet-stream",
        false,
        "GET",
        resuming ? { Range: `bytes=${diskBytes}-` } : undefined,
      );
    } catch (err) {
      if (
        attempt < 3 &&
        !(err instanceof UserError && /HTTP 4\d\d|非受信/.test(err.message))
      )
        continue;
      throw networkError(err);
    }
    let append = false;
    let offset = 0;
    if (resuming && res.statusCode === 206) {
      const range = String(res.headers["content-range"] ?? "");
      if (new RegExp(`^bytes\\s+${diskBytes}-\\d+/${a.size}$`).test(range)) {
        append = true;
        resumed = true;
        offset = diskBytes;
      } else {
        res.destroy();
        throw new UserError("断点续传响应范围与清单不一致");
      }
    } else if (attempt > 0) {
      resumed = true;
      hash = createHash("sha256");
      offset = 0;
    }
    res.socket?.setTimeout(60000);
    let writtenInPass = 0;
    try {
      await pipeline(
        res,
        new Transform({
          transform(chunk, _enc, cb) {
            writtenInPass += chunk.length;
            if (offset + writtenInPass > a.size)
              return cb(new UserError("附件超过清单大小"));
            if (!resumed) hash.update(chunk);
            cb(null, chunk);
          },
        }),
        createWriteStream(file, {
          flags: append ? "a" : attempt === 0 ? "wx" : "w",
          mode: 0o600,
        }),
      );
      diskBytes = (await fs.stat(file)).size;
      if (diskBytes === a.size) break;
      // 短响应正常 EOF（无 TCP 错）也按已落盘字节继续 Range 续传。
      if (attempt < 3 && diskBytes < a.size) continue;
      break;
    } catch (err) {
      if (err instanceof UserError) throw err;
      // 始终以磁盘真实已落盘字节作为续传起点，避免与内存缓冲错位。
      diskBytes = (await fs.stat(file).catch(() => undefined))?.size ?? 0;
      if (attempt < 3 && diskBytes < a.size) continue;
      throw new UserError("附件下载中断，请检查网络或系统代理后重试");
    }
  }
  const actualDigest = resumed ? await fileSha256(file) : hash.digest("hex");
  if (diskBytes !== a.size || actualDigest !== a.sha256.toLowerCase())
    throw new UserError("附件大小或 SHA-256 校验失败");
}
