#!/usr/bin/python3 -I
"""为已安装的订阅服务配置只读 GitHub PAT。只接受交互式终端输入。"""
import datetime
import fcntl
import getpass
import http.client
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import warnings

CONFIG = '/etc/ielts-helper-feed.env'
UNIT = 'ielts-helper-feed.service'


def log(text):
    print('[{}] {}'.format(datetime.datetime.now().isoformat(timespec='seconds'), text), flush=True)


def check_access(repo, token):
    # 固定 HTTPS 主机，不跟随任何重定向；只取状态，不打印 GitHub 响应或请求头。
    conn = http.client.HTTPSConnection('api.github.com', timeout=12)
    try:
        conn.request('GET', '/repos/{}/releases?per_page=1'.format(repo), headers={
            'Authorization': 'Bearer ' + token, 'User-Agent': 'ielts-helper-feed-setup',
            'Accept': 'application/vnd.github+json'})
        status = conn.getresponse().status
    finally:
        conn.close()
    if status != 200:
        hint = {401: '令牌无效或已过期', 403: '检查仓库权限、组织批准状态或 API 限流',
                404: '检查仓库选择、仓库名及令牌归属'}.get(status, '未能确认 Release 读取权限')
        raise RuntimeError('GitHub HTTP {}：{}；未修改配置。'.format(status, hint))


def write_private(path, data):
    # 同目录 0600 临时文件，以原子替换保留旧文件直到新内容完整写入。
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def restart_check():
    subprocess.run(['systemctl', 'restart', UNIT], check=True, timeout=45)
    for _ in range(12):
        conn = http.client.HTTPConnection('127.0.0.1', 28473, timeout=2)
        try:
            conn.request('GET', '/health')
            resp = conn.getresponse()
            if resp.status == 200 and json.loads(resp.read(2048)).get('service') == 'ielts-helper-feed':
                conn.close()
                conn.request('GET', '/manifest.json')
                if conn.getresponse().status == 401:
                    return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            conn.close()
        time.sleep(0.5)
    raise RuntimeError('订阅服务未通过回环健康与匿名鉴权检查。')


def configure(path, token):
    if not re.fullmatch(r'github_pat_[A-Za-z0-9_]+', token):
        raise RuntimeError('请使用细粒度个人访问令牌，未修改配置。')
    with open(path, 'rb') as src:
        old = src.read()
    repos = re.findall(rb'^GITHUB_REPO=([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)\r?$', old, re.M)
    targets = list(re.finditer(rb'^GITHUB_TOKEN=[^\r\n]*', old, re.M))
    if len(repos) != 1 or len(targets) != 1:
        raise RuntimeError('配置必须包含唯一的 GITHUB_REPO 与 GITHUB_TOKEN，未写入。')
    repo = repos[0].decode('ascii')
    log('检查 {} 的 Release 读取权限……'.format(repo))
    check_access(repo, token)
    m = targets[0]
    new = old[:m.start()] + b'GITHUB_TOKEN=' + token.encode('ascii') + old[m.end():]
    with open(path, 'rb') as src:
        if src.read() != old:
            raise RuntimeError('验证期间配置被修改，请重试。')
    write_private(path, new)
    try:
        restart_check()
    except BaseException:
        write_private(path, old)
        try:
            restart_check()
        except Exception:
            raise RuntimeError('旧配置已恢复，但服务未就绪；请检查 systemctl status ' + UNIT) from None
        raise RuntimeError('启用失败；旧配置已恢复，订阅服务已恢复运行。') from None
    log('私仓 Release API 读取成功；新配置已生效，回环健康与匿名鉴权正常。')


def main():
    if sys.argv[1:] == ['--help']:
        print(__doc__)
        return
    if sys.argv[1:] or os.geteuid() != 0 or not sys.stdin.isatty():
        raise RuntimeError('请使用 ssh -t，以 root 在终端交互执行，不接受参数或管道。')
    s = os.lstat(CONFIG)
    if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600 or (s.st_uid, s.st_gid) != (0, 0):
        raise RuntimeError('仅支持 root:root、权限 0600 的常规服务配置文件。')
    # 单独锁文件不包含凭据，在原子替换配置后仍能串行化多次轮换。
    with open('/run/ielts-helper-feed-token.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        warnings.simplefilter('error', getpass.GetPassWarning)
        configure(CONFIG, getpass.getpass('粘贴 VPS 专用的 GitHub 只读 PAT（输入不回显）：'))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as err:
        log(str(err))
        sys.exit(1)
    except (OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning, http.client.HTTPException):
        log('操作未完成；请检查交互终端、配置文件、网络或服务状态后重试。')
        sys.exit(1)
