import { UserError } from "../user-error";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

async function collectDirPythons(
  root: string,
  subpath: string[],
): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const entry of await fs.readdir(root))
      out.push(path.join(root, entry, ...subpath));
  } catch {
    /* 目录不存在时忽略。 */
  }
  return out;
}

/** 返回真实解释器路径（优先解析到底层非 venv 解释器），拒绝 Store 占位符；候选可注入以隔离测试。 */
export async function detectPython(
  candidates?: string[],
): Promise<{ path: string; version: string }> {
  let list = candidates;
  if (!list) {
    list = ["python", "python3", "py"];
    if (process.platform === "win32") {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local");
      list.push(
        ...(await collectDirPythons(
          path.join(localAppData, "mise/installs/python"),
          ["python.exe"],
        )),
        ...(await collectDirPythons(
          path.join(localAppData, "Programs/Python"),
          ["python.exe"],
        )),
        ...(await collectDirPythons(
          path.join(os.homedir(), ".pyenv/pyenv-win/versions"),
          ["python.exe"],
        )),
        path.join(os.homedir(), "miniconda3/python.exe"),
        path.join(os.homedir(), "anaconda3/python.exe"),
      );
      try {
        for (const entry of await fs.readdir("C:\\"))
          if (/^Python3\d+$/i.test(entry))
            list.push(path.join("C:\\", entry, "python.exe"));
      } catch {
        /* 根目录不可枚举时忽略。 */
      }
    } else {
      list.push(
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        ...(await collectDirPythons(
          path.join(os.homedir(), ".local/share/mise/installs/python"),
          ["bin", "python3"],
        )),
        path.join(os.homedir(), ".pyenv/shims/python3"),
        "/usr/bin/python3",
      );
    }
  }
  const probe =
    'import os,sys,json; base=getattr(sys,"_base_executable","") or ""; exe=base if base and os.path.isfile(base) else sys.executable; print(json.dumps({"path":exe,"version":list(sys.version_info[:3])}))';
  for (const command of [...new Set(list)]) {
    if (/Microsoft[/\\]WindowsApps/i.test(command)) continue;
    if (process.platform === "win32" && /^python3?$/.test(command)) {
      let alias = false;
      for (const rawDir of (process.env.PATH || "").split(path.delimiter)) {
        const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
        if (!dir) continue;
        try {
          await fs.access(path.join(dir, command + ".exe"));
          alias = /Microsoft[/\\]WindowsApps/i.test(dir);
          break;
        } catch {}
      }
      if (alias) continue;
    }
    const result = await new Promise<string | undefined>((resolve) =>
      execFile(
        command,
        [...(command === "py" ? ["-3"] : []), "-c", probe],
        { windowsHide: true, timeout: 5000 },
        (err, out) => resolve(err ? undefined : out),
      ),
    );
    if (result)
      try {
        const value = JSON.parse(result);
        const [major, minor] = value.version;
        if (
          major === 3 &&
          minor >= 8 &&
          typeof value.path === "string" &&
          !/Microsoft[/\\]WindowsApps/i.test(value.path)
        )
          return { path: value.path, version: value.version.join(".") };
      } catch {
        /* 非 Python 输出继续检查下一候选。 */
      }
  }
  throw new UserError("未找到 Python 3.8+，请指定解释器完整路径");
}
