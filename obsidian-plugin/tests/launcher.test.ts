import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import {
  ServiceManager,
  ServiceStartError,
  localApi,
} from "../src/launcher/service-manager";
import { detectPython } from "../src/config/python-detect";
import { profile } from "./fixtures";

test("非 Helper HTTP 占用不可判定为 stopped，也不可 spawn 或停止", async () => {
  const server = httpServer((_req, res) => {
    res.statusCode = 404;
    res.end("other service");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = profile(path.join(os.tmpdir(), "not-a-real-app"));
    p.port = (server.address() as { port: number }).port;
    const manager = new ServiceManager(p, "2.0.0");
    assert.equal(await manager.version(), undefined);
    assert.equal(await manager.state(), "external");
    await assert.rejects(manager.start(), /端口/);
    await assert.rejects(manager.stop(), /外部/);
    manager.dispose();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("外部服务可用但禁止停止，未向外部服务发送任何写请求", async () => {
  let posts = 0;
  const server = httpServer((req, res) => {
    if (req.method !== "GET") posts++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: "99.0.0",
        pluginUpgradeRequired: true,
        serviceIdentity: { instanceId: "external", pid: 1 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = profile(path.join(os.tmpdir(), "unused-ielts-fixture"));
    p.port = (server.address() as { port: number }).port;
    const service = new ServiceManager(p, "2.0.0");
    assert.equal(await service.state(), "external");
    await service.start();
    await assert.rejects(service.stop(), /外部/);
    assert.equal(posts, 0);
    service.dispose();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("临时程序启动→实例健康就绪→显式 route POST→stdin EOF 停服", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-lifecycle-"));
  const p = profile(root);
  const reserve = createServer();
  await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  p.port = (reserve.address() as { port: number }).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const py = await detectPython([process.env.IELTS_TEST_PYTHON || "python"]);
  p.pythonPath = py.path;
  const terminal = path.join(p.appRoot, "releases/4.0.0/terminal");
  await fs.mkdir(terminal, { recursive: true });
  await fs.mkdir(p.dataDir, { recursive: true });
  await fs.mkdir(p.studyRoot, { recursive: true });
  await fs.writeFile(
    path.join(p.appRoot, "current.json"),
    JSON.stringify({ version: "4.0.0" }),
  );
  await fs.writeFile(
    path.join(terminal, "IELTS_Vocab_Helper.py"),
    `import http.server,json,os,sys,threading\nport=int(sys.argv[sys.argv.index('--port')+1]); instance=sys.argv[sys.argv.index('--plugin-instance')+1]\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  value={'version':'4.0.0','pluginVersionReceived':os.environ['IELTS_PLUGIN_VERSION'],'serviceIdentity':{'instanceId':instance,'pid':os.getpid(),'port':port,'dataRoot':os.environ['IELTS_DATA_DIR'],'vaultRoot':os.environ['IELTS_VAULT']}}\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())\n def do_POST(self):\n  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'ok':True,'topic_id':data['topic_id']}).encode())\nserver=http.server.HTTPServer(('127.0.0.1',port),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n`,
  );
  const service = new ServiceManager(p, "2.0.0");
  try {
    await service.start();
    assert.equal(await service.state(), "owned");
    const version = await service.version();
    assert.equal(version?.serviceIdentity?.dataRoot, p.dataDir);
    const result = await localApi<{ ok: boolean; topic_id: string }>(
      p.port,
      "/api/vocabulary/route-inbox",
      { topic_id: "T02" },
    );
    assert.equal(result.topic_id, "T02");
    await service.stop();
    assert.equal(await service.state(), "stopped");
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows 垫片/venv 子进程 PID 与启动器不同时仍按实例 UUID 识别归属；Python 异常退出返回脱敏诊断", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-shim-"));
  const p = profile(root);
  const reserve = createServer();
  await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  p.port = (reserve.address() as { port: number }).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const py = await detectPython([process.env.IELTS_TEST_PYTHON || "python"]);
  p.pythonPath = py.path;
  const terminal = path.join(p.appRoot, "releases/4.0.0/terminal");
  await fs.mkdir(terminal, { recursive: true });
  await fs.mkdir(p.dataDir, { recursive: true });
  await fs.mkdir(p.studyRoot, { recursive: true });
  await fs.writeFile(
    path.join(p.appRoot, "current.json"),
    JSON.stringify({ version: "4.0.0" }),
  );
  // 模拟 Windows venvlauncher / shim：外层进程再 spawn 子进程，返回子进程 PID（≠ child.pid）。
  await fs.writeFile(
    path.join(terminal, "IELTS_Vocab_Helper.py"),
    `import os,subprocess,sys\nif os.environ.get('SHIM_CHILD')!='1':\n env=os.environ.copy(); env['SHIM_CHILD']='1'\n sys.exit(subprocess.call([sys.executable,*sys.argv],env=env))\nimport http.server,json,threading\nport=int(sys.argv[sys.argv.index('--port')+1]); instance=sys.argv[sys.argv.index('--plugin-instance')+1]\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  value={'version':'4.0.0','serviceIdentity':{'instanceId':instance,'pid':os.getpid(),'port':port,'dataRoot':os.environ['IELTS_DATA_DIR'],'vaultRoot':os.environ['IELTS_VAULT']}}\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())\nserver=http.server.HTTPServer(('127.0.0.1',port),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n`,
  );
  const service = new ServiceManager(p, "2.0.1");
  try {
    await service.start();
    assert.equal(await service.state(), "owned");
    assert.equal(service.hasOwnedProcess(), true);
    await service.stop();
    assert.equal(await service.state(), "stopped");
    assert.equal(service.hasOwnedProcess(), false);
    // R4：自有子进程存活但健康接口暂未应答时，state 保守返 external，hasOwnedProcess 仍为 true，不得关闭其 stdin。
    await fs.writeFile(
      path.join(terminal, "IELTS_Vocab_Helper.py"),
      `import http.server,json,os,sys,threading\nport=int(sys.argv[sys.argv.index('--port')+1]); instance=sys.argv[sys.argv.index('--plugin-instance')+1]\nready={'ok':True}\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  if not ready['ok']: self.send_response(503); self.end_headers(); return\n  value={'version':'4.0.0','serviceIdentity':{'instanceId':instance,'pid':os.getpid(),'port':port,'dataRoot':os.environ['IELTS_DATA_DIR'],'vaultRoot':os.environ['IELTS_VAULT']}}\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())\n def do_POST(self):\n  ready['ok']=False; self.send_response(200); self.end_headers(); self.wfile.write(b'{}')\nserver=http.server.HTTPServer(('127.0.0.1',port),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n`,
    );
    await service.start();
    await localApi(p.port, "/api/degrade", {});
    assert.equal(await service.state(), "external");
    assert.equal(service.hasOwnedProcess(), true);
    service.dispose();
    for (let i = 0; i < 30 && (await service.state()) !== "stopped"; i++)
      await new Promise((r) => setTimeout(r, 100));
    // R4 并发锁：beginReplace 期间阻断并发 start()；已有自有进程时 beginReplace 立即拒绝。
    service.dispose();
    const serviceLock = new ServiceManager(p, "2.0.1");
    serviceLock.beginReplace();
    await assert.rejects(serviceLock.start(), /正在保存配置/);
    serviceLock.endReplace();
    serviceLock.dispose();
    // R5：区分程序自身缺文件（如 ui-template.html，missingBaseDb=false）与题库引导缺主库（missingBaseDb=true）。
    const service2 = new ServiceManager(p, "2.0.1");
    await fs.writeFile(
      path.join(terminal, "IELTS_Vocab_Helper.py"),
      `import sys\nsys.stderr.write("secret-token-should-not-appear\\nFileNotFoundError: [Errno 2] No such file or directory: 'ui-template.html'\\n")\nsys.exit(1)\n`,
    );
    await assert.rejects(
      service2.start(),
      (err: unknown) =>
        err instanceof ServiceStartError &&
        err.reason === "exit" &&
        err.errorClass === "FileNotFoundError" &&
        err.missingBaseDb === false &&
        /退出码 1/.test(err.message) &&
        !err.message.includes("secret-token"),
    );
    await fs.writeFile(
      path.join(terminal, "IELTS_Vocab_Helper.py"),
      `import sys\nsys.stderr.write("FileNotFoundError: base database not found: C:/tmp/ielts.db\\n")\nsys.exit(1)\n`,
    );
    await assert.rejects(
      service2.start(),
      (err: unknown) =>
        err instanceof ServiceStartError &&
        err.reason === "exit" &&
        err.errorClass === "FileNotFoundError" &&
        err.missingBaseDb === true,
    );
    service2.dispose();
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
