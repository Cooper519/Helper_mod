# 部署订阅服务

首次在使用 systemd 的 Linux VPS 安装，推荐从 `vps-feed/` 目录执行 `sudo bash deploy/install-local.sh`。脚本只配置本机回环服务；域名、TLS、客户端设置及当前发布状态见[根目录使用指南](../../README.md)。以下是手动部署参数与上游格式。

需要 Go 1.22+。服务只使用标准库，正常构建不需要 C 编译器；`-race` 需要可用的 gcc。

```sh
go test -race ./...
CGO_ENABLED=0 go build -trimpath -o ielts-helper-feed .
```

创建独立系统用户 `ielts-feed`，安装二进制到 `/opt/ielts-helper-feed/`。将本目录 systemd 单元安装到 `/etc/systemd/system/`；把密钥保存在 root 管理的 `/etc/ielts-helper-feed.env`（权限 `0600`），不要提交到仓库。配置项：

| 环境变量 | 含义 |
| --- | --- |
| `LISTEN` | 建议 `127.0.0.1:28473`，默认 `:28473` |
| `ACCESS_TOKEN` | 随机客户端 Bearer 密钥，必填 |
| `PLUGIN_REPO` | 公开 GitHub 插件仓 `owner/repo`，必填 |
| `GITHUB_REPO` | 私有 GitHub Helper 仓，必填 |
| `GITHUB_TOKEN` | 服务端只读凭据 |
| `GITEE_REPO` / `GITEE_TOKEN` | 可选镜像与只读凭据 |
| `CACHE_TTL` | 元数据缓存秒数，默认 300 |
| `FEED_CONFIG` | 可选 JSON 文件路径；键为 Go 配置字段名，如 `Listen`、`AccessToken`、`PluginRepo`、`GithubRepo`、`CacheTTL`；环境变量覆盖文件 |

本机配置就绪后执行 `systemctl daemon-reload`、`systemctl enable --now ielts-helper-feed`。用 `/health` 探活；业务请求只支持请求头 `Authorization: Bearer …`，不接受 query 凭据。日志为 JSON，自动带时间，不记录请求 URL 或凭据。

### 用现有 Cloudflare Tunnel 接入

**如果已按下文配置回环 HTTPS 原站**，在 Cloudflare 中打开与该 VPS 的 `cloudflared` 对应的 Tunnel，新增一条 **Published application route（公共主机名）**：

| 配置项 | 填写值 |
|---|---|
| 公共主机名 | 子域 `ielts`，域选择你自己的域名；不要在这里填路径。 |
| 路径 | 留空。整条路由给订阅服务的 `/health`、`/manifest.json`、`/download/…`；没有成员页或管理页。 |
| 服务类型 / URL | **HTTPS** / `127.0.0.1:28474`。`28473` 是后端 HTTP，不接 TLS。 |
| TLS → Origin Server Name | `localhost`（源站证书上的名字）。 |
| TLS → CA Pool | `/etc/ielts-helper-origin/ca.pem`（连接器所在 VPS 的文件路径，不是证书内容）。 |
| TLS → 禁用 TLS 证书验证 / Match SNI to host | 两项均**关闭**。 |
| HTTP Settings → HTTP Host Header | `localhost`（匹配回环 HTTPS 站点；外部仍使用自己的域名）。 |

该源站只监听回环，无需开放公网 `28473` 或 `28474`。这条路由适用于连接器都能访问**同一个配置所指的源站与 CA** 的 Tunnel；如果同一 Tunnel 的副本分布在不同机器，请选只在该 VPS 上运行的 Tunnel。为此主机名绕过 CDN 缓存，保留 `Authorization`，不要在插件或 Actions 的请求前加交互式 Access 登录页。

保存路由后检查公网 `https://ielts.你的域名/health` 返回 `200` 并且 JSON 中 `service` 为 `ielts-helper-feed`；匿名访问 `/manifest.json` 应返回 `401` JSON。订阅链接是 `https://ielts.你的域名/manifest.json`。在插件「验证订阅」看到三类版本，才说明从公网到上游清单已打通。

**其他部署：** 若只需同机 HTTP 回源，可直接选 **HTTP** / `127.0.0.1:28473`，不填任何源站 TLS 字段；用户侧仍走 HTTPS。严格 TLS 入口使用独立的 [Caddy 配置](Caddyfile.origin) 和 [systemd 单元](ielts-helper-origin.service)，不修改主站 Caddy 或系统信任库。维护者重建时，将两者分别安装到 `/etc/ielts-helper-origin/Caddyfile` 和 `/etc/systemd/system/ielts-helper-origin.service`，执行 `systemctl daemon-reload && systemctl enable --now ielts-helper-origin`，然后将 `/var/lib/ielts-helper-origin/caddy/pki/authorities/local/root.crt` 以 `0644` 复制到 CA Pool 的路径。签发 CA 不变时，叶证书自动续签无需更新 CA Pool；若重建了 CA，需重新复制根证书、让连接器重新加载并验证链路。只分发 `root.crt`，不要复制私钥。回环诊断：

```sh
curl --noproxy '*' --resolve localhost:28474:127.0.0.1 --cacert /etc/ielts-helper-origin/ca.pem https://localhost:28474/health
```

### 补私仓读取权限：一条 SSH 命令

在 GitHub 的 **Settings → Developer settings → Personal access tokens → Fine-grained tokens** 新建有期限的令牌：Resource owner 选程序仓的所有者，Repository access 选 **Only select repositories** 并仅勾选配置为 `GITHUB_REPO` 的私仓。Repository permissions 只加 **Contents: Read-only**，保留默认的 Metadata 只读。这个 PAT 供 VPS 读取私仓 Release 和附件，不发给插件或 Actions。

在 VPS 上安装[授权脚本](set_github_token.py)后，从自己的终端运行（请替换主机名），按提示粘贴 PAT 并回车：

```sh
ssh -t root@你的VPS /opt/ielts-helper-feed/set-github-token
```

脚本先访问已配置仓库的 Release 列表；鉴权失败不改配置。成功后只更新 root 专用环境文件中的 `GITHUB_TOKEN`，仅重启订阅服务；本地健康与匿名鉴权检查不通过就恢复旧配置并再启动。轮换令牌仍运行同一命令。不在参数、链接、聊天或工单里粘贴 PAT。在另一台已用 `install-local.sh` 部署的 VPS 上，先用 `sudo install -m 0755 deploy/set_github_token.py /opt/ielts-helper-feed/set-github-token` 安装该命令（需 Python 3.6+）。

插件的「VPS 访问密钥」以及各发布仓 Actions 的 `VPS_FEED_TOKEN` 使用独立的 `ACCESS_TOKEN`，补私仓权限不会轮换它。GitHub 列表鉴权成功并不保证已发布三类合规附件：带订阅密钥时若仍收到服务返回的 `502 upstream_unavailable`，核对公开插件稳定 Release、私仓的程序和资源 Release、附件与校验清单。连 `/health` 都是 `502` 时，应先检查 Tunnel、端口、CA 和主机名，而不是更换 PAT。

## Release 格式

插件 tag `vX.Y.Z`，附件 `main.js`、`manifest.json`、`styles.css`；程序 tag `vX.Y.Z`，附件 `ielts-helper-X.Y.Z.zip`；资源 tag `resources-vX.Y.Z`，附件 `ielts-helper-resources-X.Y.Z.zip`。每个 Release 附 `checksums.txt` 或 `SHA256SUMS`，每行 `64位SHA256  文件名`。缺失校验和拒绝出清单。Release 正文的独立行携带：

```text
minPluginVersion: 2.0.0
recommendedPluginVersion: 2.0.0
```

上面两行在程序 Release 必填；资源 Release 必须有 `audioMode: on-demand` 或 `audioMode: offline`（兼容 `bundled`，值原样返回）。说明正文完整保留到 `notes`。按平台发布顺序分页寻找各组件的最新稳定候选，每页最多 100 条；过滤草稿与预发布，找到程序与资源后即停止。历史下载按精确 tag 定位。插件始终取公开 GitHub 仓；`source=gitee` 只选择 Helper 和资源镜像。

缓存过期且上游失败时继续使用该源已有的最后成功清单；首次查询全部失败返回脱敏 502。默认源 GitHub 失败后尝试 Gitee。强刷每个源键每分钟最多一次，其余请求复用缓存。下载无全局总超时，仅连接、TLS 和响应头设超时，以免截断大资源；客户端断连会取消上游请求。生产仅允许规格中的 HTTPS 主机，跨主机重定向剥离 Authorization。

**让 Release 发布后立即可查：** 按[发布仓 Actions 配置](../../README.md#让-github-发布后自动刷新订阅)，让通知和桌面端访问同一个默认 `/manifest.json`。不要给通知 URL 加 `?source=github`：它刷新的是另一份缓存。通知携带 `Cache-Control: no-cache` 并核对返回的组件 tag 和版本；如果上游失败，旧清单也可能返回 200。这个流程不需要为 VPS 开放写入端口或 SSH，也不要求发版时传输 ZIP。

## 阶段 4 隔离联调入口

仅存在于测试编译中：

```sh
FEED_TEST_ASSETS=/临时附件目录 FEED_TEST_READY=/临时目录/ready.json \
FEED_TEST_TOKEN="$随机测试密钥" go test -run '^TestIsolatedFeed$' -count=1 -timeout=30m
```

附件目录包含插件三文件、一个程序 ZIP 和一个资源 ZIP。入口优先使用打包器的 `checksums.txt` 和 `release-notes-helper-<版本>.md` / `release-notes-resources-<版本>.md`，仅在合成夹具未提供对应值时生成测试摘要或使用默认正文。ZIP 文件名提供版本号，插件版本取自 `manifest.json`。使用 `httptest.NewTLSServer`；就绪文件为 `{"url":"https://127.0.0.1:随机端口"}`，不含密钥；同时写出 `<ready路径>.pem`（SAN 包含 loopback），Node 调用方启动时设置 `NODE_EXTRA_CA_CERTS` 指向该 PEM。创建 `<ready路径>.stop` 可正常停止；也可由父进程终止测试。就绪文件退出时删除。真实生产 handler 对接 httptest 上游，只有测试 Transport 将白名单 HTTPS 请求路由到临时服务器；生产二进制不包含此入口，也不放宽重定向。

本入口为隔离联调将附件读入内存，不能用于生产大文件负载；生产 handler 的独立 350MiB 流测试使用生成器和计数写入器，不缓存完整内容。
