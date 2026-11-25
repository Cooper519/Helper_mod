import { UserError } from "../user-error";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { connect } from "node:net";
import { request } from "node:http";
import type { MachineProfile, ServiceVersion } from "../types";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function log(event: string): void {
  console.info(`[IELTS Helper ${new Date().toISOString()}] ${event}`);
}
export async function localApi<T>(
  port: number,
  route: string,
  body?: unknown,
): Promise<T> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UserError("本地接口端口无效");
  if (!/^\/(?!\/)/.test(route) || /[\\\r\n\x00#]/.test(route))
    throw new UserError("本地接口路径无效");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // 不使用 renderer fetch：Node HTTP 不发送 Origin/OPTIONS，也不放宽 Python 的跨域门禁。
  // 固定回环主机，所有 3xx 按失败处理；总期限同时覆盖建连和响应体读取。
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(error);
    };
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: payload === undefined ? "GET" : "POST",
        headers:
          payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        response.once("error", () => fail(new UserError("本地接口响应读取失败")));
        response.once("aborted", () => fail(new UserError("本地接口响应中断")));
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          fail(new UserError("本地接口响应 " + response.statusCode));
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.once("end", () => {
          if (settled) return;
          let value: T;
          try {
            value = JSON.parse(text) as T;
          } catch {
            fail(new UserError("本地接口返回无效 JSON"));
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve(value);
        });
      },
    );
    const deadline = setTimeout(() => fail(new UserError("本地接口请求超时")), 3000);
    req.once("error", () => fail(new UserError("无法连接本地学习服务")));
    req.end(payload);
  });
}
/** 只有明确的连接拒绝才视为空闲；非 Helper HTTP、超时和未知错误都保守归外部占用。 */
export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (free: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1500, () => finish(false));
  });
}
/** 只提取 Python 异常类名用于脱敏排错，绝不回显原始堆栈、路径或环境变量。 */
function extractErrorClass(stderrTail: string): string {
  const matches = stderrTail.match(/\b[A-Z][A-Za-z]+(?:Error|Exception)\b/g);
  return matches?.at(-1) ?? "";
}
/** 启动阶段的结构化脱敏错误，供安装器区分缺库与解释器/程序缺件/端口故障。 */
export class ServiceStartError extends UserError {
  constructor(
    message: string,
    readonly reason: "spawn" | "port" | "exit" | "timeout",
    readonly errorClass?: string,
    readonly missingBaseDb = false,
  ) {
    super(message);
  }
}

/** 仅持有本实例 child 和 stdin；没有任何 PID 终止或端口清理命令。 */
export class ServiceManager {
  private child?: ChildProcess;
  private instance?: string;
  private ownedPid?: number;
  private starting?: Promise<void>;
  private replacing = false;
  private closed = false;
  constructor(
    readonly config: MachineProfile,
    readonly pluginVersion: string,
  ) {}
  /** 健康接口暂未应答时仍确认是否持有存活或启动中的自有子进程。 */
  hasOwnedProcess(): boolean {
    return Boolean(this.starting || (this.child && this.child.exitCode === null));
  }
  /** 保存配置写入磁盘前同步锁定当前管理器，避免写入期间并发启动又被 dispose 关闭。 */
  beginReplace(): void {
    if (this.hasOwnedProcess())
      throw new UserError("修改配置前请先停止当前学习服务");
    this.replacing = true;
  }
  endReplace(): void {
    this.replacing = false;
  }
  async version(): Promise<ServiceVersion | undefined> {
    try {
      const v = await localApi<ServiceVersion>(
        this.config.port,
        "/api/version",
      );
      return typeof v?.version === "string" && /^\d+\.\d+\.\d+$/.test(v.version)
        ? v
        : undefined;
    } catch {
      return undefined;
    }
  }
  async state(): Promise<"owned" | "external" | "stopped"> {
    const v = await this.version();
    if (!v) {
      if (this.child && this.child.exitCode === null) return "external";
      return (await portFree(this.config.port)) ? "stopped" : "external";
    }
    const id = v.serviceIdentity;
    if (
      !this.child ||
      this.child.exitCode !== null ||
      !this.instance ||
      id?.instanceId !== this.instance ||
      typeof id?.pid !== "number" ||
      id.pid <= 0
    )
      return "external";
    // Windows venv/shim 启动器会再派生实际 python.exe 子进程，但共享同一 stdin 生命线与随机实例 UUID。
    if (id.pid === this.child.pid) {
      this.ownedPid = id.pid;
      return "owned";
    }
    if (this.ownedPid === id.pid) return "owned";
    if (this.starting && this.ownedPid === undefined) {
      this.ownedPid = id.pid;
      return "owned";
    }
    return "external";
  }
  async start(): Promise<void> {
    if (this.closed) throw new UserError("插件已卸载");
    if (this.replacing) throw new UserError("正在保存配置，请稍候重试");
    if (this.starting) return this.starting;
    this.starting = this.startReady();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async startReady(): Promise<void> {
    if (await this.version()) return;
    if (!(await portFree(this.config.port)))
      throw new ServiceStartError(
        "端口已被外部服务占用或无法确认空闲，请手动处理",
        "port",
      );
    const c = this.config;
    let current: { version?: string };
    try {
      current = JSON.parse(
        await fs.readFile(path.join(c.appRoot, "current.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new UserError("尚未安装 Helper 程序，请先初始化安装或导入程序包");
      throw new UserError("程序版本指针无法读取");
    }
    if (!current.version || !/^\d+\.\d+\.\d+$/.test(current.version))
      throw new UserError("尚未安装 Helper 程序或版本指针无效");
    const cwd = path.join(c.appRoot, "releases", current.version, "terminal");
    try {
      await fs.access(path.join(cwd, "IELTS_Vocab_Helper.py"));
    } catch {
      throw new UserError("程序目录缺少 IELTS_Vocab_Helper.py，请重新安装 Helper 程序");
    }
    this.instance = randomUUID();
    this.ownedPid = undefined;
    const child = spawn(
      c.pythonPath,
      [
        "-X",
        "utf8",
        "IELTS_Vocab_Helper.py",
        "--port",
        String(c.port),
        "--plugin-instance",
        this.instance,
        "serve",
      ],
      {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          IELTS_DATA_DIR: c.dataDir,
          IELTS_VAULT: c.studyRoot,
          IELTS_DETACHED: "1",
          IELTS_PLUGIN_VERSION: this.pluginVersion,
          PYTHONPYCACHEPREFIX: path.join(c.appRoot, "runtime/pycache"),
          IELTS_DEV_CONFIG: path.join(c.appRoot, "dev-auth.json"),
        },
      },
    );
    this.child = child;
    let spawnCode: string | undefined;
    let stderrTail = "";
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnCode = err.code || "ERROR";
    });
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      // 仅在内存保留少量尾部用于提取异常类名，不落盘、不输出原文，避免凭据泄漏。
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.ownedPid = undefined;
      }
    });
    log("请求启动学习服务");
    for (let i = 0; i < 100; i++) {
      if (this.closed || spawnCode || child.exitCode !== null) break;
      if ((await this.state()) === "owned") {
        log("学习服务健康检查就绪");
        return;
      }
      await wait(200);
    }
    child.stdin?.end();
    if (spawnCode) {
      log(`学习服务拉起失败（${spawnCode}）`);
      throw new ServiceStartError(
        "无法启动 Python 解释器，请检查 Python 路径是否存在且可执行",
        "spawn",
        spawnCode,
      );
    }
    if (child.exitCode !== null) {
      const exc = extractErrorClass(stderrTail);
      // 仅匹配题库引导层明确的缺主库异常，避免把缺少 ui-template.html 等程序缺件误判为缺题库。
      const missingBaseDb =
        exc === "FileNotFoundError" &&
        /FileNotFoundError:\s*(?:base|active) database not found:/i.test(stderrTail);
      log(`学习服务异常退出（code=${child.exitCode}${exc ? `, ${exc}` : ""}）`);
      throw new ServiceStartError(
        `本地学习服务启动失败（退出码 ${child.exitCode}${exc ? `，${exc}` : ""}），请检查数据目录数据库、学习目录与 Python 路径`,
        "exit",
        exc || undefined,
        missingBaseDb,
      );
    }
    log("学习服务启动超时");
    throw new ServiceStartError(
      "本地学习服务启动超时，请检查 Python 路径、端口占用与程序目录",
      "timeout",
    );
  }
  async stop(): Promise<void> {
    const state = await this.state();
    if (state === "stopped") return;
    if (state !== "owned")
      throw new UserError("检测到外部或归属未知服务，请先手动停止");
    const child = this.child!;
    child.stdin?.end();
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (await this.version()) throw new UserError("端口仍有服务运行");
        log("学习服务已停止");
        return;
      }
      await wait(100);
    }
    throw new UserError("服务尚未退出，已保留进程，请稍后重试");
  }
  dispose(): void {
    this.closed = true;
    this.ownedPid = undefined;
    this.child?.stdin?.end();
  }
}
