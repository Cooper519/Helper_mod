#!/usr/bin/env bash
# 在使用 systemd 的 Linux VPS 上首次安装订阅代理，只监听回环地址。
set +x
set -euo pipefail
umask 077
unit=ielts-helper-feed.service
unit_file=/etc/systemd/system/$unit
bin=/opt/ielts-helper-feed/ielts-helper-feed
env_file=/etc/ielts-helper-feed.env
port=28473
listen=127.0.0.1:$port
base=http://$listen
log() { printf '[%s] %s\n' "$(date -Is)" "$*" >&2; }
fail() { log "$*"; exit 1; }
healthy() {
    curl --noproxy '*' -fsS --max-time 2 "$base/health" 2>/dev/null | grep -Fq '"service":"ielts-helper-feed"' &&
        [[ $(curl --noproxy '*' -sS --max-time 2 -o /dev/null -w '%{http_code}' "$base/manifest.json") == 401 ]]
}

[[ $(uname -s) == Linux && $EUID == 0 ]] || fail '请在 Linux VPS 上用 sudo bash 运行此脚本。'
[[ -d /run/systemd/system ]] || fail '此安装方式需要已运行的 systemd。'
for cmd in systemctl curl ss; do command -v "$cmd" >/dev/null || fail "缺少命令：$cmd"; done
if [[ -f $env_file && -x $bin && -f $unit_file ]] && systemctl is-active --quiet "$unit" && healthy; then
    log '现有服务运行正常，未修改配置、密钥或程序。'; exit 0
fi
for file in "$env_file" "$bin" "$unit_file"; do
    [[ ! -e $file && ! -L $file ]] || fail "已有 $file，未覆盖。请用 systemctl status $unit 检查现有安装。"
done
load_state=$(systemctl show "$unit" --property=LoadState --value)
[[ $load_state == not-found ]] || fail '同名系统服务已存在，未接管。'
listeners=$(ss -H -ltn "sport = :$port")
[[ -z $listeners ]] || fail "$port 已被占用，未停止其他进程。"

here=$(cd -- "$(dirname -- "$0")" && pwd -P)
go_bin=$(command -v go || true)
[[ -n $go_bin ]] || go_bin=/usr/local/go/bin/go
[[ -x $go_bin ]] || fail '请先安装 Go 1.22 或更高版本。'
tmp=$(mktemp -d)
trap 'rm -f -- "$tmp/feed" "$tmp/env"; rmdir -- "$tmp"' EXIT
log '正在从本地源码编译订阅服务。'
(cd "$here/.." && GOTOOLCHAIN=local CGO_ENABLED=0 "$go_bin" build -trimpath -o "$tmp/feed" .)

# 仅接受可直接写入 systemd EnvironmentFile 的仓库名和 Bearer 字符；凭据不进入命令参数。
repo='^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$'
bearer='^[a-zA-Z0-9._~+/=-]+$'
IFS= read -rp '公开插件仓 [Cooper519/obsidian-ielts-helper]：' plugin
plugin=${plugin:-Cooper519/obsidian-ielts-helper}
IFS= read -rp '私有 GitHub 程序仓（owner/repo）：' github
[[ $plugin =~ $repo && $github =~ $repo ]] || fail '仓库名须为 owner/repo。'
IFS= read -rsp '该私有仓的 GitHub 只读 Token：' gh_token; printf '\n' >&2
[[ $gh_token =~ $bearer ]] || fail 'GitHub Token 为空或含无效字符。'
IFS= read -rp '可选 Gitee 镜像（owner/repo，无则回车）：' gitee
gt_token=''
if [[ -n $gitee ]]; then
    [[ $gitee =~ $repo ]] || fail 'Gitee 仓库名须为 owner/repo。'
    IFS= read -rsp 'Gitee 只读 Token：' gt_token; printf '\n' >&2
    [[ $gt_token =~ $bearer ]] || fail 'Gitee Token 为空或含无效字符。'
fi
IFS= read -rsp '客户端订阅密钥（请从密码管理器粘贴独立的随机密钥，至少 32 个字符）：' access; printf '\n' >&2
[[ $access =~ $bearer && ${#access} -ge 32 && $access != "$gh_token" && $access != "$gt_token" ]] || fail '订阅密钥须独立、至少 32 个字符，仅用字母、数字或 . _ ~ + / = -。'
printf 'LISTEN=%s\nPLUGIN_REPO=%s\nGITHUB_REPO=%s\nGITHUB_TOKEN=%s\nGITEE_REPO=%s\nGITEE_TOKEN=%s\nACCESS_TOKEN=%s\n' \
    "$listen" "$plugin" "$github" "$gh_token" "$gitee" "$gt_token" "$access" >"$tmp/env"
unset gh_token gt_token access

if ! id ielts-feed >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ielts-feed
fi
getent group ielts-feed >/dev/null || fail '服务单元需要专用的 ielts-feed 组。'
install -d -m 0755 "${bin%/*}"
install -m 0755 "$tmp/feed" "$bin"
install -m 0600 "$tmp/env" "$env_file"
install -m 0644 "$here/$unit" "$unit_file"
systemctl daemon-reload
systemctl start "$unit" || fail "启动失败；请检查 journalctl -u $unit -n 30。"
for ((i=0; i<20; i++)); do
    if systemctl is-active --quiet "$unit" && healthy; then
        systemctl enable "$unit"
        log '回环服务已就绪并设为开机启动：/health 正常，匿名清单返回 401。'; exit 0
    fi
    sleep 0.5
done
systemctl stop "$unit"
fail "就绪检查失败，已停止新服务；检查 journalctl -u $unit -n 30，修正后再启动。"
