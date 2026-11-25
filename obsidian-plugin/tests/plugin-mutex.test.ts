import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as net from "node:net";
import https from "node:https";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire, Module } from "node:module";
import { MachineConfig } from "../src/config/machine-config";
import { detectPython } from "../src/config/python-detect";
import type IELTSPlugin from "../src/main";
import type { MachineProfile } from "../src/types";

function loadPluginClass(): typeof IELTSPlugin {
  const mockObsidian = {
    Plugin: class {
      app: unknown;
      manifest: unknown;
      constructor(app: unknown, manifest: unknown) {
        this.app = app;
        this.manifest = manifest;
      }
    },
    Modal: class {
      contentEl = {
        addClass() {},
        empty() {},
        createEl(_t: string, o?: { text?: string }) {
          const btn = { onclick: null as null | (() => void), text: o?.text };
          if (o?.text === "确认继续")
            queueMicrotask(() => btn.onclick?.());
          return btn;
        },
        createDiv() {
          return this;
        },
      };
      open() {
        (this as unknown as { onOpen(): void }).onOpen();
      }
      close() {
        (this as unknown as { onClose(): void }).onClose();
      }
    },
    Notice: class {
      hide() {}
    },
    Menu: class {},
    PluginSettingTab: class {},
    Setting: class {},
    ItemView: class {},
    FileSystemAdapter: class {},
  };
  const mod = Module as unknown as {
    _load: (id: string, parent: unknown, isMain: boolean) => unknown;
  };
  const origLoad = mod._load;
  mod._load = function (id: string, parent: unknown, isMain: boolean) {
    if (id === "obsidian") return mockObsidian;
    if (id === "electron") return { shell: { openExternal: async () => {} } };
    return origLoad.call(this, id, parent, isMain);
  };
  try {
    const req = createRequire(import.meta.url);
    return (req("../src/main.ts") as { default: typeof IELTSPlugin }).default;
  } finally {
    mod._load = origLoad;
  }
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("R11：在线更新下载期与保存配置互斥，404 失败仍能恢复原学习服务；保存期间也阻断并发更新", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-r11-mutex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  const studyRoot = path.join(vaultRoot, "0-IELTS");
  const appRoot = path.join(root, "app");
  const dataDir = path.join(root, "data");
  const cfgRoot = path.join(root, "cfg");
  const terminal = path.join(appRoot, "releases", "3.8.0", "terminal");
  await fs.mkdir(path.join(studyRoot, "02-Areas"), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(terminal, { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "current.json"),
    JSON.stringify({ version: "3.8.0", resourcesVersion: "1.2.3" }),
  );
  await fs.writeFile(
    path.join(terminal, "IELTS_Vocab_Helper.py"),
    `import http.server,json,os,sys,threading\nport=int(sys.argv[sys.argv.index('--port')+1]); instance=sys.argv[sys.argv.index('--plugin-instance')+1]\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  value={'version':'3.8.0','serviceIdentity':{'instanceId':instance,'pid':os.getpid(),'port':port,'dataRoot':os.environ['IELTS_DATA_DIR'],'vaultRoot':os.environ['IELTS_VAULT']}}\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())\nserver=http.server.HTTPServer(('127.0.0.1',port),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n`,
  );

  const py = (await detectPython([process.env.IELTS_TEST_PYTHON || "python"])).path;
  const port = await freePort();
  const nextPort = await freePort();
  const PluginCtor = loadPluginClass();
  const plugin = new PluginCtor(
    {} as never,
    { id: "ielts-helper", version: "2.0.1" } as never,
  );
  plugin.config = new MachineConfig(vaultRoot, cfgRoot);
  const baseProfile: MachineProfile = {
    vaultRoot,
    studyRoot,
    appRoot,
    dataDir,
    pythonPath: py,
    port,
    openBrowserOnStart: false,
    autoUpgradePlugin: false,
    updateSource: {
      mode: "vps",
      vpsUrl: "https://feed.example",
      vpsToken: randomUUID(),
    },
  };
  await plugin.save(baseProfile);
  await plugin.needService().start();
  assert.equal(await plugin.needService().state(), "owned");

  let enterDownload!: () => void;
  const downloadStarted = new Promise<void>((r) => {
    enterDownload = r;
  });
  let release404!: () => void;
  const proceed404 = new Promise<void>((r) => {
    release404 = r;
  });
  const manifest = {
    schema: 1,
    generatedAt: "2026-11-25T00:00:00Z",
    source: "github",
    plugin: {
      version: "2.0.1",
      tag: "v2.0.1",
      publishedAt: "2026-11-25T00:00:00Z",
      notes: "",
      assets: {
        "main.js": { url: "/download/plugin/2.0.1/main.js", size: 1, sha256: "a".repeat(64) },
        "manifest.json": { url: "/download/plugin/2.0.1/manifest.json", size: 1, sha256: "a".repeat(64) },
        "styles.css": { url: "/download/plugin/2.0.1/styles.css", size: 1, sha256: "a".repeat(64) },
      },
    },
    helper: {
      version: "3.9.0",
      tag: "v3.9.0",
      publishedAt: "2026-11-25T00:00:00Z",
      notes: "",
      minPluginVersion: "2.0.0",
      recommendedPluginVersion: "2.0.0",
      asset: {
        filename: "ielts-helper-3.9.0.zip",
        url: "/download/helper/3.9.0/ielts-helper-3.9.0.zip",
        size: 100,
        sha256: "b".repeat(64),
      },
    },
    resources: {
      version: "1.2.3",
      tag: "resources-v1.2.3",
      publishedAt: "2026-11-25T00:00:00Z",
      notes: "",
      audioMode: "on-demand",
      asset: {
        filename: "ielts-helper-resources-1.2.3.zip",
        url: "/download/resources/1.2.3/ielts-helper-resources-1.2.3.zip",
        size: 100,
        sha256: "c".repeat(64),
      },
    },
  };
  t.mock.method(
    https,
    "request",
    (url: URL, _opts: unknown, callback: (res: unknown) => void) => {
      return Object.assign(new EventEmitter(), {
        setTimeout() {},
        end() {
          if (url.pathname === "/manifest.json") {
            const res = Object.assign(
              Readable.from([Buffer.from(JSON.stringify(manifest))]),
              { statusCode: 200, headers: {} },
            );
            queueMicrotask(() => callback(res));
            return;
          }
          enterDownload();
          void proceed404.then(() => {
            const res = Object.assign(Readable.from([]), {
              statusCode: 404,
              headers: {},
            });
            callback(res);
          });
        },
      });
    },
  );

  try {
    const updatePromise = plugin.installOnline(["helper"]);
    await downloadStarted;
    // 更新停服后的下载窗口内尝试改端口保存：必须立即拒绝，不得 dispose 原 ServiceManager。
    await assert.rejects(
      plugin.save({ ...baseProfile, port: nextPort }),
      /正在执行安装或更新/,
    );
    release404();
    await assert.rejects(updatePromise, /HTTP 404/);
    // 失败恢复后原端口上的学习服务已重新就绪，配置未被篡改。
    assert.equal(plugin.profile?.port, port);
    assert.equal(await plugin.needService().state(), "owned");
    assert.equal((await plugin.needService().version())?.version, "3.8.0");

    await plugin.needService().stop();
    assert.equal(await plugin.needService().state(), "stopped");

    // 反向互斥：save() 正在写盘时并发进入 exclusive() 必须被拒绝。
    const origSave = plugin.config.save.bind(plugin.config);
    let concurrentUpdateErr: unknown;
    plugin.config.save = async (p) => {
      await plugin
        .exclusive(async () => {})
        .catch((e) => {
          concurrentUpdateErr = e;
        });
      return origSave(p);
    };
    await plugin.save({ ...baseProfile, port: nextPort });
    assert.match(String(concurrentUpdateErr), /正在保存配置/);
    plugin.config.save = origSave;
  } finally {
    plugin.service?.dispose();
  }
});
