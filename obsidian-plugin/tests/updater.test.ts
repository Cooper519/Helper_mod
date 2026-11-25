import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fileOps from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import cp, { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import * as net from "node:net";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  compareVersions,
  getManifest,
  getPackageFeed,
  withDownloadedPackage,
  installPackages,
  localPackage,
  readInstalled,
  rollbackHelper,
  updatePlugin,
  pluginFiles,
  type PackageInput,
  type ServiceHooks,
  type FeedManifest,
} from "../src/updater/index";
import {
  connectHttpProxy,
  connectSocks5Proxy,
  download,
  isProxyBypassed,
  openStream,
  parseMacProxy,
  parseWindowsProxy,
  providerAccess,
  vpsAccess,
} from "../src/updater/network";
import { ServiceStartError } from "../src/launcher/service-manager";

const sum = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
// 夹具仅表达条目元信息；Python 标准库生成跨平台 ZIP，不调用解压程序。
async function pack(
  dir: string,
  version: string,
  kind: "helper" | "resources",
  entries: Record<string, string>,
  symbol = false,
) {
  const file = path.join(
    dir,
    `ielts-helper-${kind === "resources" ? "resources-" : ""}${version}.zip`,
  );
  const script = `import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n,b in json.load(sys.stdin).items():\n  e=zipfile.ZipInfo(n)\n  if sys.argv[2]=='link': e.create_system=3; e.external_attr=0o120777<<16\n  z.writestr(e,b)`;
  const r = spawnSync(
    process.env.IELTS_TEST_PYTHON || "python",
    ["-c", script, file, symbol ? "link" : "plain"],
    { input: JSON.stringify(entries), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return localPackage(file, sum(await fs.readFile(file)));
}
function fixtureService() {
  let live = false;
  const calls: string[] = [];
  const service: ServiceHooks = {
    state: async () => (live ? "owned" : "stopped"),
    stop: async () => {
      calls.push("stop");
      live = false;
    },
    start: async () => {
      calls.push("start");
      live = true;
    },
  };
  return { service, calls };
}
const program = { "terminal/IELTS_Vocab_Helper.py": "# 测试程序" };
const resources = {
  "content.db": "试题",
  "vocabulary.db": "单词",
  "dictation.db": "听写",
  "learning-progress.db": "不能覆盖",
  "study-books/demo.pdf": "书",
  "source-profiles/device-bindings.json": "不能写",
  "listening/sound.zip": "录音",
};
test("本地初始化、手动升级、启动失败恢复和手动回退使用同一版本指针，学习库不变", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-updater-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  await fs.mkdir(paths.dataDir);
  await fs.writeFile(
    path.join(paths.dataDir, "learning-progress.db"),
    "原有记录",
  );
  const a = await pack(root, "3.1.0", "helper", program),
    b = await pack(root, "3.2.0", "helper", program),
    r = await pack(root, "1.0.0", "resources", resources);
  const { service, calls } = fixtureService();
  await fs.writeFile(
    path.join(root, "checksums.txt"),
    `${a.sha256}  ${path.basename(a.file)}\n`,
  );
  assert.deepEqual(await localPackage(a.file), a);
  await installPackages(paths, [a, r], service);
  assert.deepEqual(calls, ["start"]);
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "listening/sound.zip"), "utf8"),
    "录音",
  );
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "learning-progress.db"), "utf8"),
    "原有记录",
  );
  await assert.rejects(
    fs.access(path.join(paths.dataDir, "source-profiles/device-bindings.json")),
  );
  let bad = true;
  const failing = {
    ...service,
    start: async () => {
      if (bad) {
        bad = false;
        throw Error("启动失败");
      }
      await service.start();
    },
  };
  await assert.rejects(installPackages(paths, [b], failing), /启动失败/);
  assert.equal((await readInstalled(paths.appRoot)).version, a.version);
  assert.equal(await service.state(), "owned");
  await installPackages(paths, [b], service);
  assert.equal((await readInstalled(paths.appRoot)).previousVersion, a.version);
  await rollbackHelper(paths, service);
  assert.equal((await readInstalled(paths.appRoot)).version, a.version);
  assert.equal(await service.state(), "owned");
});
test("拒绝摘要不符、目录穿越和链接条目，端口属于外部服务时不调用停止", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-refuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
      appRoot: path.join(root, "app"),
      dataDir: path.join(root, "data"),
      vaultRoot: path.join(root, "vault"),
    },
    svc = fixtureService();
  const normal = await pack(root, "1.0.0", "helper", program),
    bad: PackageInput = { ...normal, sha256: "f".repeat(64) };
  await assert.rejects(installPackages(paths, [bad], svc.service), /SHA-256/);
  const parent = await pack(root, "1.0.1", "helper", {
    "../sentinel": "仅作拒绝断言",
  });
  await assert.rejects(installPackages(paths, [parent], svc.service));
  const link = await pack(root, "1.0.2", "helper", program, true);
  await assert.rejects(installPackages(paths, [link], svc.service), /链接/);
  assert.deepEqual(await fs.readdir(paths.appRoot), []);
  assert.deepEqual(await fs.readdir(paths.dataDir), []);
  await assert.rejects(
    installPackages(paths, [normal], {
      ...svc.service,
      state: async () => "external",
    }),
    /外部/,
  );
  assert.deepEqual(svc.calls, []);
});
type Reply = { bytes?: string; status?: number; location?: string; contentType?: string };
function mockHttp(
  t: import("node:test").TestContext,
  reply: (url: URL, headers: Record<string, string>) => Reply,
) {
  t.mock.method(
    https,
    "request",
    (
      url: URL,
      opts: { headers: Record<string, string> },
      callback: (v: unknown) => void,
    ) => {
      const o = reply(url, opts.headers),
        res = Object.assign(Readable.from([Buffer.from(o.bytes ?? "")]), {
          statusCode: o.status ?? 200,
          headers: { location: o.location, "content-type": o.contentType },
        });
      return Object.assign(new EventEmitter(), {
        setTimeout() {},
        end() {
          queueMicrotask(() => callback(res));
        },
      });
    },
  );
}
test("跨主机跳转剥离密钥，拒绝白名单外主机和同域不同端口", async (t) => {
  const headers: (string | undefined)[] = [];
  let dest = "https://two.example/download";
  mockHttp(t, (url, h) => {
    headers.push(h.Authorization);
    return url.host === "one.example"
      ? { status: 302, location: dest }
      : { bytes: "附件" };
  });
  const sec = randomUUID(),
    a = {
      origin: "https://one.example",
      allowed: ["https://one.example", "https://two.example"],
      token: sec,
    };
  (await openStream("/asset", a, "application/octet-stream")).destroy();
  assert.deepEqual(headers, [`Bearer ${sec}`, undefined]);
  dest = "https://two.example:9443/file";
  await assert.rejects(openStream("/asset", a, ""), /受信/);
  assert.equal(headers.length, 3);
});
test("公开插件三文件校验、重载失败恢复旧版、成功激活；公开源请求不含凭据", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-plugin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = {
      "main.js": "新版代码",
      "manifest.json": JSON.stringify({ id: "ielts-helper", version: "2.1.0" }),
      "styles.css": "/* 新版 */",
    },
    old = {
      "main.js": "旧版代码",
      "manifest.json": JSON.stringify({ id: "ielts-helper", version: "2.0.0" }),
      "styles.css": "/* 旧版 */",
    };
  const release = {
    version: "2.1.0",
    tag: "v2.1.0",
    notes: "",
    publishedAt: "",
    assets: Object.fromEntries(
      pluginFiles.map((n) => [
        n,
        {
          url: "https://api.github.com/" + n,
          size: Buffer.byteLength(bytes[n]),
          sha256: sum(bytes[n]),
        },
      ]),
    ),
  } as FeedManifest["plugin"];
  const s = { mode: "github" as const, githubToken: randomUUID() };
  const snapshot = () =>
    Promise.all(
      pluginFiles.map((n) => fs.readFile(path.join(root, n), "utf8")),
    );
  for (const n of pluginFiles) await fs.writeFile(path.join(root, n), old[n]);
  let corrupt = true;
  mockHttp(t, (url, h) => {
    assert.equal(h.Authorization, undefined);
    const n = url.pathname.slice(1) as keyof typeof bytes;
    return { bytes: corrupt && n === "styles.css" ? "损坏" : bytes[n] };
  });
  let loads = 0;
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      loads++;
    }),
  );
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  assert.equal(loads, 0);
  corrupt = false;
  const rename = fileOps.rename;
  let failOnce = true;
  const fault = t.mock.method(
    fileOps,
    "rename",
    async (
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ) => {
      if (failOnce && String(to) === path.join(root, "manifest.json")) {
        failOnce = false;
        throw new Error("模拟第二文件写入失败");
      }
      return rename(from, to);
    },
  );
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      loads++;
    }),
    /第二文件/,
  );
  fault.mock.restore();
  assert.equal(loads, 0);
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      if (++loads === 1) throw Error("模拟重载失败");
    }),
  );
  assert.equal(loads, 2);
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  await updatePlugin(s, release, root, async () => {
    loads++;
  });
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => bytes[n]),
  );
});
test("离线模式不发出请求；版本比较按数字分段", async () => {
  await assert.rejects(getManifest({ mode: "local" }), /本地/);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
});

test("订阅根地址与清单链接只读同一清单，错误路径或带凭据 URL 不发送请求", async (t) => {
  const token = randomUUID();
  let calls = 0;
  mockHttp(t, (url, headers) => {
    calls++;
    assert.equal(url.href, "https://feed.example/manifest.json");
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(headers["Cache-Control"], "no-cache");
    return { status: 401 };
  });
  const check = (url: string) =>
    getManifest({ mode: "vps", vpsUrl: url, vpsToken: token }, true);
  for (const suffix of ["", "/manifest.json"]) {
    await assert.rejects(check("https://feed.example" + suffix), /401/);
  }
  for (const url of [
    "http://feed.example",
    "https://feed.example/owner/repo/releases",
    `https://feed.example/manifest.json?token=${token}`,
  ]) {
    await assert.rejects(check(url), /订阅|HTTPS/);
  }
  assert.equal(calls, 2);
});

test("订阅 502 区分上游发布不可用与网关错误，不回显服务端正文", async (t) => {
  let gateway = false;
  mockHttp(t, () => ({
    status: 502,
    contentType: gateway ? "text/html" : "application/json",
    bytes: gateway ? "内部网关详情" : '{"error":"upstream_unavailable"}',
  }));
  const check = () => getManifest({ mode: "vps", vpsUrl: "https://feed.example", vpsToken: randomUUID() });
  await assert.rejects(check(), /502.*上游.*发布/);
  gateway = true;
  await assert.rejects(check(), /502.*\/health/);
});

test("私有源直连符合 A8：优先静默 GCM，GCM 无效或权限不足时自动回落手填令牌；支持双格式、纯 light、跨页选最高版与缺摘要回退旧版", async (t) => {
  // R12：全用例隔离宿主 GITHUB_TOKEN / GITEE_TOKEN，避免宿主环境变量污染断言。
  const savedGithubEnv = process.env.GITHUB_TOKEN;
  const savedGiteeEnv = process.env.GITEE_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITEE_TOKEN;
  t.after(() => {
    if (savedGithubEnv === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubEnv;
    if (savedGiteeEnv === undefined) delete process.env.GITEE_TOKEN;
    else process.env.GITEE_TOKEN = savedGiteeEnv;
  });
  const primary = randomUUID(),
    fallback = randomUUID();
  let have = true;
  let rejectGcmAuth = false;
  let publicDown = false;
  let dualRelease = false;
  let pureLightRelease = false;
  let incompleteNewer = false;
  let missingLightDigestNewer = false;
  let authFailNewerChecksum = false;
  let multiPage = false;
  let lightChecksum = true;
  const lightName = "ielts-helper-light-3.0.0.zip";
  const seen: string[] = [];
  t.mock.method(
    cp,
    "spawn",
    (_cmd: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
      assert.equal(o.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(o.env.GCM_INTERACTIVE, "never");
      const child = Object.assign(new EventEmitter(), {
        stdin: undefined as unknown as Writable,
        stdout: Readable.from(have ? ["password=" + primary + "\n"] : []),
        kill() {},
      });
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          assert.match(
            String(chunk),
            /^protocol=https\nhost=(github|gitee)\.com\n\n$/,
          );
          cb();
        },
        final(cb) {
          setImmediate(() => child.emit("close", have ? 0 : 1));
          cb();
        },
      });
      return child;
    },
  );
  const names = [
    "main.js",
    "manifest.json",
    "styles.css",
    "ielts-helper-3.0.0.zip",
    "ielts-helper-resources-1.0.0.zip",
  ];
  mockHttp(t, (url, h) => {
    const isPublic = url.pathname.includes("/demo/public/");
    if (isPublic && publicDown) return { status: 503 };
    if (isPublic) assert.equal(h.Authorization, undefined);
    else {
      if (rejectGcmAuth && h.Authorization === `Bearer ${primary}`)
        return { status: 401 };
      const expected = have && !rejectGcmAuth ? primary : fallback;
      assert.equal(h.Authorization, `Bearer ${expected}`);
      seen.push(url.origin);
    }
    assert.ok(!url.href.includes(primary) && !url.href.includes(fallback));
    const make = (
      tag: string,
      body: string,
      ns: readonly string[],
      withSum = true,
      sumPath?: string,
    ) => ({
      tag_name: tag,
      body,
      created_at: "2026-11-23T00:00:00Z",
      assets: [
        ...ns.map((n) => ({
          name: n,
          size: 1,
          browser_download_url:
            url.origin + (isPublic ? "/demo/public/" : "/demo/private/") + n,
        })),
        ...(withSum
          ? [
              {
                name: "checksums.txt",
                size: 1,
                browser_download_url:
                  url.origin +
                  (isPublic ? "/demo/public/" : "/demo/private/") +
                  (sumPath || "checksums.txt"),
              },
            ]
          : []),
      ],
    });
    if (url.pathname.endsWith("/releases")) {
      const page = Number(url.searchParams.get("page") || "1");
      if (!isPublic && multiPage) {
        if (page === 1) {
          const fillers = Array.from({ length: 98 }, (_, i) =>
            make(`note-${i}`, "非发布", [], false),
          );
          return {
            bytes: JSON.stringify([
              make("resources-v1.0.0", "audioMode: offline", [names[4]]),
              make(
                "v3.0.0",
                "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.1.0",
                [names[3]],
              ),
              ...fillers,
            ]),
          };
        }
        return {
          bytes: JSON.stringify([
            make(
              "v3.2.0",
              "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.1.0",
              ["ielts-helper-3.2.0.zip"],
              true,
              "checksums-3.2.0.txt",
            ),
          ]),
        };
      }
      const helperAssets = pureLightRelease
        ? [lightName]
        : dualRelease
          ? [names[3], lightName]
          : [names[3]];
      return {
        bytes: JSON.stringify(
          isPublic
            ? [make("v2.0.0", "发布", names.slice(0, 3))]
            : [
                ...(incompleteNewer
                  ? [
                      make(
                        "v3.9.0",
                        "无校验清单与元数据",
                        ["ielts-helper-3.9.0.zip"],
                        false,
                      ),
                    ]
                  : []),
                ...(missingLightDigestNewer
                  ? [
                      make(
                        "v3.9.0",
                        "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.1.0",
                        ["ielts-helper-3.9.0.zip", "ielts-helper-light-3.9.0.zip"],
                        true,
                        "checksums-3.9.0.txt",
                      ),
                    ]
                  : []),
                make("resources-v1.0.0", "audioMode: offline", [names[4]]),
                make(
                  "v3.0.0",
                  "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.1.0",
                  helperAssets,
                ),
              ],
        ),
      };
    }
    if (url.pathname.endsWith("/checksums-3.9.0.txt")) {
      if (authFailNewerChecksum) return { status: 401 };
      // 新版清单漏写 light 摘要，只列了传统包。
      return { bytes: `${sum("old")}  ielts-helper-3.9.0.zip\n` };
    }
    if (url.pathname.endsWith("/checksums-3.2.0.txt")) {
      return { bytes: `${sum("320")}  ielts-helper-3.2.0.zip\n` };
    }
    if (url.pathname.endsWith("/" + lightName)) return { bytes: "L" };
    const checks = names.map((n) => `${sum("x")}  ${n}`);
    if ((dualRelease || pureLightRelease) && lightChecksum)
      checks.push(`${sum("L")}  ${lightName}`);
    return { bytes: checks.join("\n") };
  });
  // A8：GCM 有效时优先使用 GCM（不因历史回退令牌覆盖有效 GCM）；R10：未使用的 GITHUB_TOKEN 含换行不阻断有效 GCM。
  process.env.GITHUB_TOKEN = "unused\nbroken-token";
  try {
    assert.equal(
      (
        await providerAccess(
          { mode: "github", githubToken: fallback },
          "github",
          true,
        )
      ).token,
      primary,
    );
    const r10Feed = await getPackageFeed({
      mode: "github",
      githubRepo: "demo/private",
      githubToken: "also\ninvalid-unused",
    });
    assert.equal(r10Feed.helper.version, "3.0.0");
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
  // R10/R12 边界：清除环境令牌后，无 GCM 且仅手填令牌含换行时必须报错；存在合法环境令牌时仍保留回退能力。
  have = false;
  await assert.rejects(
    getPackageFeed({
      mode: "github",
      githubRepo: "demo/private",
      githubToken: "bad\nonly-token",
    }),
    /换行/,
  );
  process.env.GITHUB_TOKEN = fallback;
  try {
    const envFallbackFeed = await getPackageFeed({
      mode: "github",
      githubRepo: "demo/private",
      githubToken: "bad\nignored-by-env-fallback",
    });
    assert.equal(envFallbackFeed.helper.version, "3.0.0");
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
  have = true;
  for (const provider of ["github", "gitee"] as const) {
    const m = await getManifest({
      mode: provider,
      pluginRepo: "demo/public",
      githubRepo: "demo/private",
      giteeRepo: "demo/private",
      githubToken: fallback,
      giteeToken: fallback,
    });
    assert.equal(m.helper.version, "3.0.0");
    assert.equal(m.helper.minPluginVersion, "2.0.0");
    assert.equal(m.resources.audioMode, "offline");
    have = false;
  }
  // A8 扩展：GCM 返回 401 时自动回落手填令牌完成查询与下载。
  have = true;
  rejectGcmAuth = true;
  dualRelease = true;
  const fallbackSource = {
    mode: "github",
    githubRepo: "demo/private",
    githubToken: `  ${fallback}  `,
  } as const;
  const fallbackFeed = await getPackageFeed(fallbackSource);
  assert.equal(fallbackFeed.helper.version, "3.0.0");
  await withDownloadedPackage(fallbackSource, fallbackFeed, "helper", async (pkg) => {
    assert.equal(await fs.readFile(pkg.file, "utf8"), "L");
  });
  rejectGcmAuth = false;
  have = false;
  publicDown = true;
  assert.equal(
    (
      await getPackageFeed({
        mode: "gitee",
        giteeRepo: " demo/private ",
        giteeToken: fallback,
      })
    ).helper.version,
    "3.0.0",
  );
  assert.ok(
    seen.includes("https://api.github.com") &&
      seen.includes("https://gitee.com"),
  );
  // R3：新版 3.9.0 清单漏写 light 摘要时，跳过整个 3.9.0 回退到完整 3.0.0；不借用传统摘要。
  dualRelease = true;
  incompleteNewer = false;
  missingLightDigestNewer = true;
  const source = { mode: "github", githubRepo: "demo/private", githubToken: fallback } as const;
  const feed = await getPackageFeed(source);
  assert.equal(feed.helper.version, "3.0.0");
  assert.equal(feed.helper.asset.filename, names[3]);
  assert.equal(feed.helper.asset.sha256, sum("L"));
  // R3 边界：鉴权错误（401）绝不掩盖为版本残缺而回退旧版。
  authFailNewerChecksum = true;
  await assert.rejects(getPackageFeed(source), /401/);
  authFailNewerChecksum = false;
  missingLightDigestNewer = false;
  // R6：跨页选择所有页中的最高完整稳定版（第 1 页 3.0.0，第 2 页 3.2.0）。
  dualRelease = false;
  multiPage = true;
  const pagedFeed = await getPackageFeed(source);
  assert.equal(pagedFeed.helper.version, "3.2.0");
  multiPage = false;
  // 纯 light 发布（没有传统同名包）也应正常识别并交付规范名。
  incompleteNewer = true;
  pureLightRelease = true;
  const pureFeed = await getPackageFeed(source);
  assert.equal(pureFeed.helper.version, "3.0.0");
  assert.equal(pureFeed.helper.asset.filename, names[3]);
  assert.equal(pureFeed.helper.asset.sha256, sum("L"));
  lightChecksum = false;
  await assert.rejects(getPackageFeed(source), /校验/);
});

// 与旧版构建器相同的三条目布局；发布摘要取自封装前的发布端，而非安装器。
test("完整包校验内外两层，只安装程序和白名单资源；任一子包失败不停止旧服务", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  const old = await pack(root, "3.7.6", "helper", program),
    h = await pack(root, "3.8.0", "helper", {
      ...program,
      "main.js": "旧插件",
      "manifest.json": "{}",
      "release.json": "{}",
      "styles.css": "",
    }),
    r = await pack(root, "1.2.3", "resources", resources);
  const { service, calls } = fixtureService();
  await installPackages(paths, [old], service);
  await fs.writeFile(
    path.join(paths.dataDir, "learning-progress.db"),
    "原记录",
  );
  const file = path.join(root, "ielts-helper-full-3.8.0.zip");
  const make = async (broken: boolean) => {
    const meta = {
      kind: "ielts-install-bundle",
      schema: 1,
      version: h.version,
      resourceVersion: r.version,
      components: {
        "program.zip": { size: (await fs.stat(h.file)).size, sha256: h.sha256 },
        "resources.zip": {
          size: (await fs.stat(r.file)).size,
          sha256: broken ? "0".repeat(64) : r.sha256,
        },
      },
    };
    const z = spawnSync(
      process.env.IELTS_TEST_PYTHON || "python",
      [
        "-c",
        `import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('bundle.json',sys.stdin.read());z.write(sys.argv[2],'program.zip');z.write(sys.argv[3],'resources.zip')`,
        file,
        h.file,
        r.file,
      ],
      { input: JSON.stringify(meta) },
    );
    assert.equal(z.status, 0);
    return localPackage(file, sum(await fs.readFile(file)));
  };
  await assert.rejects(
    localPackage(path.join(root, "ielts-helper-full-3.8.1.zip")),
    /SHA-256/,
  );
  // 文件名命中旧回执也不能放行不同字节。
  await make(false);
  await assert.rejects(
    installPackages(paths, [await localPackage(file)], service),
    /SHA-256/,
  );
  await assert.rejects(
    installPackages(paths, [await make(true)], service),
    /SHA-256/,
  );
  assert.deepEqual(calls, ["start"]);
  assert.equal((await readInstalled(paths.appRoot)).version, "3.7.6");
  const full = await make(false);
  await assert.rejects(installPackages(paths, [full, r], service));
  await assert.rejects(installPackages(paths, [h], service), /terminal/);
  await installPackages(paths, [full], service);
  const installed = await readInstalled(paths.appRoot);
  assert.deepEqual(
    [installed.version, installed.previousVersion, installed.resourcesVersion],
    ["3.8.0", "3.7.6", "1.2.3"],
  );
  assert.deepEqual(
    await fs.readdir(path.join(paths.appRoot, "releases/3.8.0")),
    ["terminal"],
  );
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "learning-progress.db"), "utf8"),
    "原记录",
  );
  await fs.writeFile(
    path.join(paths.dataDir, "content.db"),
    "同版资源保持原样",
  );
  await installPackages(paths, [full], service);
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "content.db"), "utf8"),
    "同版资源保持原样",
  );
});
test("运行中的锁不能抢占；已退出且没有待恢复材料的锁可接管", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  await fs.mkdir(paths.appRoot);
  const file = path.join(paths.appRoot, ".ielts-update.lock"),
    pkg = await pack(root, "3.8.0", "helper", program),
    { service } = fixtureService();
  const lock = (pid: number) =>
    fs.writeFile(file, `${new Date().toISOString()} ${pid}\n`);
  await lock(process.pid);
  await assert.rejects(installPackages(paths, [pkg], service), /已有更新锁/);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(dead.status, 0);
  await lock(dead.pid);
  await installPackages(paths, [pkg], service);
  assert.equal((await readInstalled(paths.appRoot)).version, "3.8.0");
});

test("本地 ZIP 支持 light 命名、.sha256 旁路与双 Release checksums (1).txt，并拒绝冲突摘要", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-light-local-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lightFile = path.join(root, "ielts-helper-light-3.8.0.zip");
  const script = `import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n,b in json.load(sys.stdin).items(): z.writestr(n,b)`;
  const r1 = spawnSync(
    process.env.IELTS_TEST_PYTHON || "python",
    ["-c", script, lightFile],
    { input: JSON.stringify(program), encoding: "utf8" },
  );
  assert.equal(r1.status, 0, r1.stderr);
  const lightSha = sum(await fs.readFile(lightFile));
  const resPkg = await pack(root, "1.2.3", "resources", resources);
  // 模拟从两个 GitHub Release 下载到同一目录，浏览器将第二个保存为 checksums (1).txt。
  await fs.writeFile(
    path.join(root, "checksums.txt"),
    `${lightSha}  ielts-helper-light-3.8.0.zip\n`,
  );
  await fs.writeFile(
    path.join(root, "checksums (1).txt"),
    `${resPkg.sha256}  ielts-helper-resources-1.2.3.zip\n`,
  );
  const parsedLight = await localPackage(lightFile);
  const parsedRes = await localPackage(resPkg.file);
  assert.equal(parsedLight.kind, "helper");
  assert.equal(parsedLight.version, "3.8.0");
  assert.equal(parsedLight.sha256, lightSha);
  assert.equal(parsedRes.sha256, resPkg.sha256);
  // 同目录出现冲突摘要必须拒绝。
  await fs.appendFile(
    path.join(root, "checksums (1).txt"),
    `${"a".repeat(64)}  ielts-helper-light-3.8.0.zip\n`,
  );
  await assert.rejects(localPackage(lightFile), /不一致/);
  // 旧资源命名 + 单文件 .sha256 旁路也应正常识别；若与 checksums.txt 摘要冲突则拒绝（R8）。
  const legacyRes = path.join(root, "ielts-resources-1.2.3.zip");
  await fs.copyFile(resPkg.file, legacyRes);
  await fs.writeFile(`${legacyRes}.sha256`, `${resPkg.sha256}  ielts-resources-1.2.3.zip\n`);
  const parsedLegacyRes = await localPackage(legacyRes);
  assert.equal(parsedLegacyRes.kind, "resources");
  assert.equal(parsedLegacyRes.version, "1.2.3");
  // 同目录 checksums.txt 给出不同摘要时，.sha256 不得掩盖冲突。
  await fs.appendFile(
    path.join(root, "checksums.txt"),
    `${"b".repeat(64)}  ielts-resources-1.2.3.zip\n`,
  );
  await assert.rejects(localPackage(legacyRes), /不一致/);
});

test("新机支持先装资源再装 Helper；缺库启动不回滚，但解释器/端口故障必须报错回滚（R5）", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-stepwise-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const h = await pack(root, "3.8.0", "helper", program);
  const r = await pack(root, "1.2.3", "resources", resources);
  // 路径 1：先装资源，再装 Helper。
  const p1 = {
    appRoot: path.join(root, "app1"),
    dataDir: path.join(root, "data1"),
    vaultRoot: path.join(root, "vault1"),
  };
  const s1 = fixtureService();
  const res1 = await installPackages(p1, [r], s1.service);
  assert.deepEqual(res1, { started: false, missing: "helper" });
  assert.deepEqual(s1.calls, []);
  assert.equal((await readInstalled(p1.appRoot)).resourcesVersion, "1.2.3");
  const res2 = await installPackages(p1, [h], s1.service);
  assert.deepEqual(res2, { started: true });
  assert.equal((await readInstalled(p1.appRoot)).version, "3.8.0");
  // 路径 2：空 dataDir 解释器不存在（spawn ENOENT）、端口冲突或程序自身缺文件（如 ui-template.html），必须直接失败回滚，不能报缺资源。
  const pBad = {
    appRoot: path.join(root, "app-bad"),
    dataDir: path.join(root, "data-bad"),
    vaultRoot: path.join(root, "vault-bad"),
  };
  const sBad = fixtureService();
  await assert.rejects(
    installPackages(pBad, [h], {
      ...sBad.service,
      start: async () => {
        throw new ServiceStartError("无法启动 Python 解释器", "spawn", "ENOENT");
      },
    }),
    /Python 解释器/,
  );
  assert.equal((await readInstalled(pBad.appRoot)).version, undefined);
  await assert.rejects(
    installPackages(pBad, [h], {
      ...sBad.service,
      start: async () => {
        throw new ServiceStartError("端口已被外部服务占用", "port");
      },
    }),
    /端口/,
  );
  assert.equal((await readInstalled(pBad.appRoot)).version, undefined);
  await assert.rejects(
    installPackages(pBad, [h], {
      ...sBad.service,
      start: async () => {
        throw new ServiceStartError(
          "本地学习服务启动失败（退出码 1，FileNotFoundError）",
          "exit",
          "FileNotFoundError",
          false,
        );
      },
    }),
    /FileNotFoundError/,
  );
  assert.equal((await readInstalled(pBad.appRoot)).version, undefined);
  // 路径 3：空 dataDir 确因缺库（missingBaseDb=true）退出时不回滚，随后补资源启动成功。
  const p2 = {
    appRoot: path.join(root, "app2"),
    dataDir: path.join(root, "data2"),
    vaultRoot: path.join(root, "vault2"),
  };
  const s2 = fixtureService();
  const dbCheckedService: ServiceHooks = {
    ...s2.service,
    start: async () => {
      const hasDb = await fs
        .stat(path.join(p2.dataDir, "content.db"))
        .then(() => true)
        .catch(() => false);
      if (!hasDb)
        throw new ServiceStartError(
          "本地学习服务启动失败（退出码 1，FileNotFoundError）",
          "exit",
          "FileNotFoundError",
          true,
        );
      await s2.service.start();
    },
  };
  const step1 = await installPackages(p2, [h], dbCheckedService);
  assert.deepEqual(step1, { started: false, missing: "resources" });
  assert.equal((await readInstalled(p2.appRoot)).version, "3.8.0");
  const step2 = await installPackages(p2, [r], dbCheckedService);
  assert.deepEqual(step2, { started: true });
  assert.equal(await dbCheckedService.state(), "owned");
});

test("系统代理配置解析、绕过列表、令牌清洗与大附件断流 Range 续传", async (t) => {
  const win = parseWindowsProxy(
    "ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\nProxyOverride    REG_SZ    localhost;127.*;*.local;<local>\r\n",
  );
  assert.equal(win.proxy?.href, "http://127.0.0.1:7897/");
  assert.equal(isProxyBypassed("127.0.0.1", win.bypass), true);
  assert.equal(isProxyBypassed("intranet", win.bypass), true);
  assert.equal(isProxyBypassed("api.github.com", win.bypass), false);
  const winOff = parseWindowsProxy("ProxyEnable REG_DWORD 0x0\r\nProxyServer REG_SZ 127.0.0.1:7897\r\n");
  assert.equal(winOff.proxy, undefined);
  const mac = parseMacProxy(
    "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7890\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n}\n",
  );
  assert.equal(mac.proxy?.href, "http://127.0.0.1:7890/");
  assert.equal(isProxyBypassed("demo.local", mac.bypass), true);
  assert.equal(
    vpsAccess({ mode: "vps", vpsUrl: "  https://feed.example/manifest.json  ", vpsToken: "  secret-key  " }).token,
    "secret-key",
  );
  assert.throws(
    () => vpsAccess({ mode: "vps", vpsUrl: "https://feed.example", vpsToken: "bad\nkey" }),
    /换行/,
  );
  // 模拟附件下载中途断流：首批 8 字节真正落盘后流中断，二次请求自动按磁盘字节 Range 续传并完成全量 SHA-256 校验。
  const payload = Buffer.from("0123456789abcdefghij");
  const ranges: (string | undefined)[] = [];
  let calls = 0;
  t.mock.method(
    https,
    "request",
    (_url: URL, opts: { headers: Record<string, string> }, callback: (v: unknown) => void) => {
      calls++;
      ranges.push(opts.headers.Range);
      let step = 0;
      const start = opts.headers.Range
        ? Number(/^bytes=(\d+)-$/.exec(opts.headers.Range)?.[1] ?? 0)
        : 0;
      const stream = new Readable({
        read() {
          if (calls === 1) {
            if (step === 0) {
              step = 1;
              this.push(payload.subarray(0, 8));
            } else if (step === 1) {
              step = 2;
              setTimeout(
                () => this.destroy(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
                20,
              );
            }
          } else {
            this.push(payload.subarray(start));
            this.push(null);
          }
        },
      });
      const res = Object.assign(stream, {
        statusCode: calls === 1 ? 200 : start > 0 ? 206 : 200,
        headers:
          calls === 1 || start === 0
            ? {}
            : { "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` },
      });
      return Object.assign(new EventEmitter(), {
        setTimeout() {},
        end() {
          queueMicrotask(() => callback(res));
        },
      });
    },
  );
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "pack.zip");
  await download(
    { url: "/download/helper/3.8.0/ielts-helper-3.8.0.zip", size: payload.length, sha256: sum(payload) },
    { origin: "https://feed.example", allowed: ["https://feed.example"], token: "t" },
    target,
  );
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readFile(target), payload);
  // R7：短响应正常 EOF（无错误事件、无 Content-Length）也自动按已落盘字节 Range 续传；满长但摘要错误仍拒绝。
  let eofCalls = 0;
  const eofRanges: (string | undefined)[] = [];
  t.mock.method(
    https,
    "request",
    (_url: URL, opts: { headers: Record<string, string> }, callback: (v: unknown) => void) => {
      eofCalls++;
      eofRanges.push(opts.headers.Range);
      const start = opts.headers.Range
        ? Number(/^bytes=(\d+)-$/.exec(opts.headers.Range)?.[1] ?? 0)
        : 0;
      const chunk = eofCalls === 1 ? payload.subarray(0, 8) : payload.subarray(start);
      const res = Object.assign(Readable.from([chunk]), {
        statusCode: opts.headers.Range ? 206 : 200,
        headers:
          !opts.headers.Range
            ? {}
            : { "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` },
      });
      return Object.assign(new EventEmitter(), {
        setTimeout() {},
        end() {
          queueMicrotask(() => callback(res));
        },
      });
    },
  );
  const eofTarget = path.join(root, "short-eof.zip");
  await download(
    { url: "/download/helper/3.8.0/ielts-helper-3.8.0.zip", size: payload.length, sha256: sum(payload) },
    { origin: "https://feed.example", allowed: ["https://feed.example"], token: "t" },
    eofTarget,
  );
  assert.deepEqual(eofRanges, [undefined, "bytes=8-"]);
  assert.deepEqual(await fs.readFile(eofTarget), payload);
  // 满长但摘要错误必须拒绝，不进入无限续传。
  await assert.rejects(
    download(
      { url: "/download/helper/3.8.0/ielts-helper-3.8.0.zip", size: payload.length, sha256: "f".repeat(64) },
      { origin: "https://feed.example", allowed: ["https://feed.example"], token: "t" },
      path.join(root, "bad-sha.zip"),
    ),
    /SHA-256/,
  );
  // 真实本地 HTTP CONNECT 代理隧道端到端验证。
  const echo = net.createServer((sock) => {
    sock.once("data", (d) => sock.end(Buffer.concat([Buffer.from("OK:"), d])));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const connectTargets: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    connectTargets.push(req.url || "");
    const [h, pStr] = (req.url || "").split(":");
    const up = net.connect(Number(pStr), h, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on("error", () => clientSocket.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => echo.close(() => r()));
  });
  const tunnel = await connectHttpProxy(
    new URL(`http://127.0.0.1:${proxyPort}`),
    "127.0.0.1",
    echoPort,
  );
  const reply = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    tunnel.on("data", (c: Buffer) => chunks.push(c));
    tunnel.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    tunnel.on("error", reject);
    tunnel.write("ping");
  });
  assert.deepEqual(connectTargets, [`127.0.0.1:${echoPort}`]);
  assert.equal(reply, "OK:ping");
  // R2：SOCKS5 完整应答一次性发完、分段发送均能正常进入数据转发；接通后挂起在有限时间超时。
  let socksMode: "single" | "split" | "hang" = "single";
  const socksServer = net.createServer((sock) => {
    let stage = 0;
    sock.on("data", (chunk) => {
      if (socksMode === "hang") return;
      if (stage === 0) {
        stage = 1;
        sock.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 1) {
        stage = 2;
        const okReply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]);
        if (socksMode === "single") {
          sock.write(okReply);
        } else {
          sock.write(okReply.subarray(0, 4));
          setTimeout(() => sock.write(okReply.subarray(4)), 15);
        }
      } else {
        sock.end(Buffer.concat([Buffer.from("SOCKS:"), chunk]));
      }
    });
  });
  await new Promise<void>((r) => socksServer.listen(0, "127.0.0.1", r));
  const socksPort = (socksServer.address() as net.AddressInfo).port;
  t.after(() => new Promise<void>((r) => socksServer.close(() => r())));
  for (const mode of ["single", "split"] as const) {
    socksMode = mode;
    const s = await connectSocks5Proxy(
      new URL(`socks5://127.0.0.1:${socksPort}`),
      "example.com",
      443,
      2000,
    );
    const out = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      s.on("data", (c: Buffer) => chunks.push(c));
      s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      s.on("error", reject);
      s.write("hello");
    });
    assert.equal(out, "SOCKS:hello");
  }
  socksMode = "hang";
  await assert.rejects(
    connectSocks5Proxy(
      new URL(`socks5://127.0.0.1:${socksPort}`),
      "example.com",
      443,
      200,
    ),
    /握手超时/,
  );
});
