# IELTS Helper：从 Obsidian 打开本机学习服务

一个订阅地址管三项更新：**Obsidian 插件、IELTS Helper 程序、学习资源包**。VPS 提供版本清单并转发下载，Python 学习服务和题库仍在你的电脑上。已有订阅地址和访问密钥，无需自己搭 VPS。

**先用临时 Vault 试装。** 本仓提供 [Obsidian 插件](obsidian-plugin/README.md)、[本地试用包](obsidian-plugin/dist/ielts-helper-obsidian-2.0.0-local.zip)和 [VPS 订阅服务](vps-feed/deploy/README.md)。不含 Python 主程序、题库、学习记录或订阅凭据。没有可用 Release 时，直接用下文的本地安装方式。

## 在 Obsidian 安装插件

使用 **Obsidian 桌面版 1.5.0+**，先打开一个空的临时 Vault。

**现在试用：本地三文件。** 将[本地试用包](obsidian-plugin/dist/ielts-helper-obsidian-2.0.0-local.zip)解压到临时 Vault 的 `.obsidian/plugins/` 下，使 `main.js`、`manifest.json`、`styles.css` 位于同一个 `ielts-helper/` 子目录。重开该 Vault，在「设置 → 第三方插件」中启用 **IELTS Helper**。若从源码构建，在 `obsidian-plugin` 目录运行 `npm ci`、`npm run build`，再复制这三个文件即可。

**发布后：用 GitHub 链接导入。** 等[独立插件仓的 Releases](https://github.com/Cooper519/obsidian-ielts-helper/releases) 出现稳定版，并确认附件含上述三个文件；维护者还需附 `checksums.txt` 或 `SHA256SUMS` 供订阅更新校验。

1. 在「设置 → 第三方插件 → 浏览」搜索 **BRAT**，安装并启用。
2. 在 BRAT 设置点 **添加 Beta 插件**，粘贴下面这个**仓库主页**，选定已发布的稳定版本，点 **添加插件**。公开插件无需填写 GitHub Token。

   ```text
   https://github.com/Cooper519/obsidian-ielts-helper
   ```

3. 回到「第三方插件」确认 **IELTS Helper** 已启用。若要使用 IELTS Helper 自带的校验与回滚更新，从 BRAT 的跟踪列表移除此项即可；移除跟踪不会卸载插件。不要粘贴当前集成仓、源码子目录或私有 Helper 仓的链接。[BRAT 使用说明](https://github.com/TfTHacker/obsidian42-brat)

### 从订阅链接检查、下载和更新

1. 打开「设置 → IELTS Helper → 更新源与本机路径」，选择 **VPS 订阅（推荐）**。在「VPS HTTPS 地址」粘贴订阅链接，例如 `https://feed.example.com/manifest.json`（根地址也可以），将运营者给的**客户端订阅密钥**单独填入「VPS 访问密钥」。这里不填 GitHub Release 网页、源码 ZIP、私仓 Token 或 VPS 的内网端口。
2. 点 **测试连接**。无需先保存配置或安装 Python，按钮旁会显示这条链接提供的「插件 · Helper · 资源」三个版本。这一步只请求清单，不下载包。`401` 先核对密钥；`502` 请运营者检查三类稳定 Release、校验清单与上游访问权限。
3. 按需要选择一个动作：

   | 目的 | 在「版本与更新」点击 | 结果 |
   |---|---|---|
   | 首次安装学习服务 | 在「运行状态」点 **初始化安装**（先填好路径和更新源） | 确认后下载程序和资源两包；四库就绪后可打开学习页 |
   | 已安装，只换程序或题库 | **更新 Helper** 或 **更新资源** | 只下载选中的包，验证大小与 SHA-256 后安装，重启自有学习服务，不重载 Obsidian 插件 |
   | 只升级 Obsidian 插件 | **升级插件** | 直接使用表单里的源；有更高版本时下载、校验并替换三文件，重载失败则还原。不要求先初始化 Helper |

后续使用同一已保存订阅，直接点 **立即检查** 即可请求刷新；后台检查不会安装 Helper 或资源。订阅读取的是已发布的附件，不是源码分支：若只有 source commit 更新、同版本附件被替换，或只上传了 GitHub 自动生成的 *Source code (zip)*，就不会得到可识别的新版号。维护者应使用新版本号发布对应附件，格式见下方发布表。

### 第一次打开学习页

在「设置 → IELTS Helper」中，选择 Vault 外两个互不包含的**新目录**作为「外部程序目录」和「外部数据目录」，学习目录先保留临时 Vault 下的 `0-IELTS`。选择本机 Python 3.8+ 解释器和一个空闲端口；本次试用不点「接管旧安装」。

- **有本地包**：更新源选「仅本地 ZIP」。把程序 ZIP、资源 ZIP 和对应的 `checksums.txt` 放在同一目录，保留原文件名；在「导入本地 ZIP」中同时选择两个 ZIP，点「导入 ZIP」并确认。无需公开 Release 或 VPS。
- **有旧版完整包**：单独选择 `ielts-helper-full-3.8.0.zip` 后点「导入 ZIP」。本次迁移构建已内置发布方校验值，无需改名、拆包或重载 Obsidian。其他构建请提供对应发布方的 SHA-256。
- **有可用订阅**：测试连接后点「初始化安装」并确认。

看到 Helper 与资源版本、四库均「已就绪」后，点 **打开学习页**。首次安装成功后，本机配置才会持久保存。「立即检查」只查版本；以后更新 Helper 或资源需要手动确认。

## 在 Linux VPS 上一键配置本地订阅服务

适用于使用 **systemd** 的 Linux VPS，需要 Bash、Go 1.22+、`curl`、`ss`（iproute2）及管理员权限。把本工作区的 **`vps-feed/` 源码和 `deploy/` 子目录**复制到 VPS；不必传工具链、测试产物、私有 Helper 源码或学习数据。在 `vps-feed/` 的上一级运行：

```sh
sudo bash vps-feed/deploy/install-local.sh
```

[安装脚本](vps-feed/deploy/install-local.sh) 会询问公开插件仓、私有 Helper 仓及其只读 Token、可选 Gitee 镜像，以及从密码管理器生成的独立客户端密钥（至少 32 位）。密钥输入不回显，保存在 root 专用的 `/etc/ielts-helper-feed.env`（`0600`）；**只把客户端密钥交给插件用户**。

脚本编译 Go 服务，以专用用户启动 `ielts-helper-feed.service`，只监听 VPS 的 `127.0.0.1:28473`。健康检查通过后才设为开机启动。再次运行不会覆盖已有配置或轮换密钥，也不会停止占用端口的其他服务。

```sh
curl -fsS http://127.0.0.1:28473/health                         # JSON 中 ok 为 true
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28473/manifest.json  # 未带密钥：401
sudo journalctl -u ielts-helper-feed -n 30 --no-pager           # 启动失败时看原因
```

**使用 Cloudflare Tunnel 时**，先按[部署指南](vps-feed/deploy/README.md#用现有-cloudflare-tunnel-接入)配置回环原站，再将自有主机名映射到它并保持证书校验开启。客户端只需订阅链接和访问密钥；上游私仓的只读 PAT 只在 VPS 上配置。

自建其他 VPS 时也可使用 [Nginx 反代示例](vps-feed/deploy/nginx.conf.example)，配置域名和有效证书，转发到 `http://127.0.0.1:28473`，保留 `Authorization` 并关闭代理缓冲。使用 Nginx 时执行 `sudo nginx -t && sudo systemctl reload nginx`，再访问 `https://你的域名/health`。不需要对公网开放回环端口。

**已用 8080 安装的 VPS：** 不必重装。先用 `ss -H -ltn 'sport = :28473'` 确认新端口空闲，再用 `sudoedit /etc/ielts-helper-feed.env` 只改 `LISTEN=127.0.0.1:28473`，并将现有 Nginx 站点的 `proxy_pass` 改为 `http://127.0.0.1:28473`。先 `sudo nginx -t`，再 `sudo systemctl restart ielts-helper-feed`；确认新端口的 `/health` 正常后执行 `sudo systemctl reload nginx`。若新服务未就绪，把 `LISTEN` 与 `proxy_pass` 改回原值并重启服务。对外仍走 HTTPS 443，插件里的域名和密钥不用改。

`/health` 正常只说明服务在运行。发布齐全后，用桌面插件的「检查」验证完整链路：应显示插件、Helper 和资源三个版本。清单返回 `401` 时检查订阅密钥及反代请求头；返回 `502` 时核对私有仓读取权限、上游可达性和[三类 Release 的附件与校验清单格式](vps-feed/deploy/README.md)。当前 Gitee 镜像只替代 Helper 和资源，不能代替不可达的 GitHub 公开插件仓。

## 发新版：附件放 Release，不上传 VPS

| 哪部分变了 | 发布到哪里 | 附件 |
|---|---|---|
| Obsidian 插件 | 独立公开插件仓，稳定版 `vX.Y.Z` | `main.js`、`manifest.json`、`styles.css` 和校验清单 |
| Python 程序 | 私有 Helper 仓，稳定版 `vX.Y.Z` | `ielts-helper-X.Y.Z.zip` 和校验清单；正文注明最低及推荐插件版本 |
| 学习资源 | 同一私有仓，独立的 `resources-vX.Y.Z` | `ielts-helper-resources-X.Y.Z.zip` 和校验清单；正文注明 `audioMode` |

GitHub 自动生成的 *Source code (zip)*、旧 `full.zip` 或旧式单包 `.zip.sha256` 不符合此表。通知不会把旧包转换成新格式；程序和资源都按上表发布后，客户端才有可校验的下载入口。

### 让 GitHub 发布后自动刷新订阅

1. **在实际发布 Release 的仓库启用工作流。** 插件使用[插件工程里的通知工作流](obsidian-plugin/.github/workflows/notify-vps.yml)；私有 Helper 仓的一份工作流同时处理程序和资源。把工作流及其调用的脚本纳入各自默认分支和今后的发布版本。仅放在本集成仓，收不到其他仓库的发布事件。
2. **一次性设置地址与密钥。** 在各发布仓的 **Settings → Secrets and variables → Actions**，在 **Variables** 新建 `VPS_FEED_URL`，填插件使用的完整 HTTPS 清单地址，如 `https://feed.example.com/manifest.json`（换成自己的域名，不带查询参数）。在 **Secrets** 新建 `VPS_FEED_TOKEN`，值为 VPS 的客户端 `ACCESS_TOKEN`。不要填 GitHub PAT、SSH 密钥或把密钥拼进链接。
3. **附件齐全后点 Publish release。** 工作流会要求 VPS 刷新默认清单，再核对本次发布标签。例如发布 `resources-v1.2.4`，必须看到 `resources.tag` 为 `resources-v1.2.4` 才算成功。无需再传 ZIP、重启 VPS 或修改订阅地址。即使不启用 Action，插件仍能在缓存到期后查到上游新版（默认 300 秒）。
4. **在 Obsidian 使用新版。** 开启「自动检查更新」后，下次加载插件会查到新版；已打开的 Obsidian 可直接点「检查」，不用等推送。点「更新 Helper」或「更新资源」并确认，插件才下载、校验和安装；升级 Helper 会重启它自己管理的 Python 服务，不重载 Obsidian 插件。插件本身可独立选择自动自升级。

**已经发过 Release？** 启用工作流不会补发历史事件。若把已发布的预发布版转成正式版，未出现新的通知运行，也用下面的入口补跑。到该仓的 **Actions → 发布后刷新 VPS 清单 → Run workflow**，在私有仓先选 `helper` 或 `resources`，再输入已发布、应当在订阅中显示的完整标签。若返回 `401`，核对订阅密钥；返回 `502` 或持续显示旧 tag，检查三类上游 Release、附件、校验清单和正文。补齐后重跑通知，不用再发一个版本。

**哪些操作不会通知？** 普通 `git push`、草稿、预发布和只在 Gitee 发布均不会触发这条 GitHub 流程。若另一个 Action 用默认 `GITHUB_TOKEN` 创建 Release，GitHub 不会因此启动第二个 `release` 工作流；请在发布任务上传完附件后显式触发本通知或手动补跑（见 [GitHub 触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)）。通知只确认已发布版本对订阅可见，不负责打包或创建 Release；程序与资源独立发版，不必重做旧式 `full.zip`。

旧安装如何接管、如何在独立 Vault 中验证，见[插件使用说明](obsidian-plugin/README.md#用临时旧安装夹具接管)。
