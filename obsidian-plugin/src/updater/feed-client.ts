import { UserError } from "../user-error";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checksum } from "./archive";
import {
  checkAsset,
  download,
  isAuthFallbackError,
  openStream,
  providerAccess,
  providerCandidates,
  text,
  vpsAccess,
  type Access,
  type AuthCandidate,
} from "./network";
import {
  archiveName,
  compareVersions,
  pluginFiles,
  stable,
  type Asset,
  type Release,
  type Kind,
  type PackageInput,
  type FeedManifest,
  type PackageFeed,
  type SourceConfig,
  type Provider,
  type PluginFile,
} from "./types";

function checkRelease(r: Release) {
  if (
    !r ||
    !stable.test(r.version) ||
    typeof r.tag !== "string" ||
    typeof r.notes !== "string" ||
    typeof r.publishedAt !== "string"
  )
    throw new UserError("发布记录格式错误");
}
function validatePackages(f: PackageFeed, vps = false): PackageFeed {
  if (
    f?.schema !== 1 ||
    !["github", "gitee"].includes(f.source) ||
    typeof f.generatedAt !== "string"
  )
    throw new UserError("无法识别的订阅清单");
  for (const k of ["helper", "resources"] as const) {
    const r = f[k];
    checkRelease(r);
    const name = archiveName(k, r.version),
      a = r.asset;
    checkAsset(a);
    const route = `/download/${k}/${r.version}/${name}`;
    if (vps && a.url !== route && a.url !== `${route}?source=${f.source}`)
      throw new UserError("清单下载路径不符合契约");
    if (a.filename !== name) throw new UserError("发布附件名与版本不匹配");
  }
  if (
    !stable.test(f.helper.minPluginVersion) ||
    !stable.test(f.helper.recommendedPluginVersion) ||
    !["on-demand", "offline", "bundled"].includes(f.resources.audioMode)
  )
    throw new UserError("缺少兼容性或资源元数据");
  return f;
}
type UpAsset = {
  name: string;
  id?: number;
  size?: number;
  browser_download_url?: string;
};
type UpRelease = {
  tag_name: string;
  assets: UpAsset[];
  body?: string;
  published_at?: string;
  created_at?: string;
  draft?: boolean;
  prerelease?: boolean;
};
async function releases(
  provider: Provider,
  rawRepo: string,
  access: Access,
  kinds: (Kind | "plugin")[],
): Promise<UpRelease[]> {
  const repo = rawRepo.trim();
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..")
  )
    throw new UserError("仓库名应为 所有者/仓库");
  const root =
    provider === "github"
      ? "https://api.github.com/repos/"
      : "https://gitee.com/api/v5/repos/";
  const collected: UpRelease[] = [];
  let last = "";
  for (let page = 1; ; page++) {
    const rows: UpRelease[] = JSON.parse(
      await text(`${root}${repo}/releases?per_page=100&page=${page}`, access),
    );
    if (!Array.isArray(rows)) throw new UserError("发布列表格式错误");
    for (const r of rows) {
      if (kinds.some((k) => Boolean(candidate(r, k)))) collected.push(r);
    }
    if (rows.length < 100) break;
    const tail = rows[rows.length - 1].tag_name;
    if (tail === last) throw new UserError("上游发布分页未前进");
    last = tail;
  }
  return collected;
}
function assetUrl(a: UpAsset, repo: string, provider: Provider) {
  if (provider === "github" && Number.isSafeInteger(a.id))
    return `https://api.github.com/repos/${repo.trim()}/releases/assets/${a.id}`;
  if (!a.browser_download_url) throw new UserError("附件缺少下载地址");
  return a.browser_download_url;
}
function field(body: string, key: string) {
  return (
    body
      .split(/\r?\n/)
      .map(
        (l) => new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, "i").exec(l)?.[1],
      )
      .find(Boolean) ?? ""
  );
}
function candidate(r: UpRelease, kind: Kind | "plugin") {
  if (r.draft || r.prerelease || !Array.isArray(r.assets)) return;
  const ver = (
    kind === "resources"
      ? /^resources-v(\d+\.\d+\.\d+)$/
      : /^v?(\d+\.\d+\.\d+)$/
  ).exec(r.tag_name)?.[1];
  if (!ver) return;
  const hasChecksum = r.assets.some(
    (a) => a.name === "checksums.txt" || a.name === "SHA256SUMS",
  );
  const body = r.body ?? "";
  const hasMeta =
    kind === "plugin"
      ? true
      : kind === "helper"
        ? stable.test(field(body, "minPluginVersion")) &&
          stable.test(field(body, "recommendedPluginVersion"))
        : ["on-demand", "offline", "bundled"].includes(field(body, "audioMode"));
  const complete = hasChecksum && hasMeta;
  if (kind === "helper") {
    // 双格式或纯轻量发布均优先选 light 附件，并按其真实文件名核对摘要。
    const light = `ielts-helper-light-${ver}.zip`;
    if (r.assets.some((a) => a.name === light))
      return { ver, names: [light], complete };
    const standard = archiveName(kind, ver);
    if (r.assets.some((a) => a.name === standard))
      return { ver, names: [standard], complete };
    return;
  }
  const names = kind === "plugin" ? pluginFiles : [archiveName(kind, ver)];
  if (!names.every((n) => r.assets.some((a) => a.name === n))) return;
  return { ver, names, complete };
}
/** 两个私有 Release 单独选择，不能把最新资源标签误认为程序版本。 */
async function component(
  rows: UpRelease[],
  kind: Kind | "plugin",
  provider: Provider,
  repo: string,
  access: Access,
) {
  const matched = rows
    .map((r) => ({ r, match: candidate(r, kind) }))
    .filter(
      (
        x,
      ): x is {
        r: UpRelease;
        match: NonNullable<ReturnType<typeof candidate>>;
      } => Boolean(x.match),
    )
    .sort((a, b) => {
      if (a.match.complete !== b.match.complete)
        return a.match.complete ? -1 : 1;
      return compareVersions(b.match.ver, a.match.ver);
    });
  let lastManifestError: UserError | undefined;
  for (const { r, match } of matched) {
    const { ver, names } = match;
    const by = new Map(r.assets.map((a) => [a.name, a]));
    const sum = by.get("checksums.txt") ?? by.get("SHA256SUMS");
    if (!sum) {
      const label = { plugin: "插件", helper: "Helper", resources: "资源" }[kind];
      lastManifestError ??= new UserError(
        `${label} ${ver} 缺少 checksums.txt 或 SHA256SUMS，请维护者补齐轻量发布附件`,
      );
      continue;
    }
    if (!match.complete) {
      lastManifestError ??= new UserError("缺少兼容性或资源元数据");
      continue;
    }
    // 鉴权与网络错误立即透出，不掩盖为版本残缺；仅跳过校验清单缺项或元数据不完整的候选。
    const checks = await text(
      assetUrl(sum, repo, provider),
      access,
      "application/octet-stream",
    );
    const digests: [string, string][] = [];
    let checksumError: UserError | undefined;
    for (const name of names) {
      try {
        digests.push([name, checksum(checks, name)]);
      } catch (e) {
        if (e instanceof UserError) {
          checksumError = e;
          break;
        }
        throw e;
      }
    }
    if (checksumError) {
      lastManifestError ??= checksumError;
      continue;
    }
    const assets: Record<string, Asset> = {};
    let assetError: UserError | undefined;
    for (const [name, sha256] of digests) {
      const a = by.get(name)!,
        url = assetUrl(a, repo, provider);
      let size = a.size;
      if (size === undefined) {
        const res = await openStream(
          url,
          access,
          "application/octet-stream",
          false,
          "HEAD",
        );
        const len = res.headers["content-length"];
        res.destroy();
        if (len === undefined) {
          assetError = new UserError("上游没有提供附件大小");
          break;
        }
        size = Number(len);
      }
      const item = { url, size, sha256 };
      try {
        checkAsset(item);
      } catch (e) {
        if (e instanceof UserError) {
          assetError = e;
          break;
        }
        throw e;
      }
      assets[kind === "helper" ? archiveName(kind, ver) : name] = item;
    }
    if (assetError) {
      lastManifestError ??= assetError;
      continue;
    }
    const release: Release = {
      version: ver,
      tag: r.tag_name,
      notes: r.body ?? "",
      publishedAt: r.published_at ?? r.created_at ?? "",
    };
    return { release, assets };
  }
  if (lastManifestError) throw lastManifestError;
  throw new UserError(`仓库中没有可用的 ${kind} 稳定版`);
}
const pubRepo = (s: SourceConfig) =>
  s.pluginRepo?.trim() || "Cooper519/obsidian-ielts-helper";
async function publicPlugin(s: SourceConfig): Promise<FeedManifest["plugin"]> {
  const repo = pubRepo(s),
    a = await providerAccess(s, "github", false),
    c = await component(
      await releases("github", repo, a, ["plugin"]),
      "plugin",
      "github",
      repo,
      a,
    );
  return { ...c.release, assets: c.assets as Record<PluginFile, Asset> };
}
export async function getPluginRelease(
  s: SourceConfig,
  refresh = false,
): Promise<FeedManifest["plugin"]> {
  if (s.mode === "local") throw new UserError("仅本地模式不会检查在线发布");
  return s.mode === "vps"
    ? (await getManifest(s, refresh)).plugin
    : publicPlugin(s);
}
export async function getManifest(
  s: SourceConfig,
  refresh = false,
): Promise<FeedManifest> {
  if (s.mode === "local") throw new UserError("仅本地模式不会检查在线发布");
  if (s.mode === "vps") {
    const a = vpsAccess(s);
    const f: FeedManifest = JSON.parse(
      await text("/manifest.json", a, "application/json", refresh),
    );
    validatePackages(f, true);
    checkRelease(f.plugin);
    for (const name of pluginFiles) {
      const a = f.plugin.assets?.[name];
      checkAsset(a);
      const route = `/download/plugin/${f.plugin.version}/${name}`;
      if (a.url !== route && a.url !== `${route}?source=${f.source}`)
        throw new UserError("清单下载路径不符合契约");
    }
    return f;
  }
  const [packages, plugin] = await Promise.all([
    getPackageFeed(s),
    publicPlugin(s),
  ]);
  return { ...packages, plugin };
}
async function withAuthFallback<T>(
  candidates: AuthCandidate[],
  action: (access: Access) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if ("error" in item) {
      lastErr = item.error;
      continue;
    }
    try {
      return await action(item.access);
    } catch (err) {
      lastErr = err;
      if (i + 1 < candidates.length && isAuthFallbackError(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

/** 直连程序与资源独立于公开插件仓；VPS 仍强校验完整三组件清单。 */
export async function getPackageFeed(
  s: SourceConfig,
  refresh = false,
): Promise<PackageFeed> {
  if (s.mode === "vps" || s.mode === "local") return getManifest(s, refresh);
  const provider = s.mode,
    repo = (provider === "github" ? s.githubRepo : s.giteeRepo)?.trim();
  if (!repo) throw new UserError("请填写当前更新源的私有仓库名（格式：所有者/仓库）");
  const candidates = await providerCandidates(s, provider, true);
  return withAuthFallback(candidates, async (a) => {
    const rows = await releases(provider, repo, a, ["helper", "resources"]);
    const [h, r] = await Promise.all([
        component(rows, "helper", provider, repo, a),
        component(rows, "resources", provider, repo, a),
      ]),
      hn = archiveName("helper", h.release.version),
      rn = archiveName("resources", r.release.version);
    return validatePackages({
      schema: 1,
      generatedAt: new Date().toISOString(),
      source: provider,
      helper: {
        ...h.release,
        asset: { ...h.assets[hn], filename: hn },
        minPluginVersion: field(h.release.notes, "minPluginVersion"),
        recommendedPluginVersion: field(
          h.release.notes,
          "recommendedPluginVersion",
        ),
      },
      resources: {
        ...r.release,
        asset: { ...r.assets[rn], filename: rn },
        audioMode: field(r.release.notes, "audioMode"),
      },
    });
  });
}
export async function withDownloadedPackage(
  s: SourceConfig,
  m: PackageFeed,
  k: Kind,
  callback: (pkg: PackageInput) => Promise<void>,
) {
  if (s.mode === "local") throw new UserError("本地模式请选择 ZIP");
  validatePackages(m, s.mode === "vps");
  const candidates: AuthCandidate[] =
      s.mode === "vps"
        ? [{ access: vpsAccess(s) }]
        : await providerCandidates(s, s.mode, true),
    release = m[k];
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ielts-download-"));
  try {
    const f = path.join(dir, release.asset.filename);
    await withAuthFallback(candidates, async (access) => {
      await fs.rm(f, { force: true });
      await download(release.asset, access, f);
    });
    await callback({
      kind: k,
      version: release.version,
      file: f,
      sha256: release.asset.sha256,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
