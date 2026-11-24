"""将刚构建的标准三文件封装为可解压到 .obsidian/plugins/ 的本地试用包。"""
import json
import os
import tempfile
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / "dist" / f"ielts-helper-obsidian-{version}-local.zip"
out.parent.mkdir(exist_ok=True)
with tempfile.NamedTemporaryFile(dir=out.parent, delete=False) as f:
    stage = Path(f.name)
try:
    with zipfile.ZipFile(stage, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ("main.js", "manifest.json", "styles.css"):
            archive.write(root / name, f"ielts-helper/{name}")
    os.replace(stage, out)
finally:
    stage.unlink(missing_ok=True)
print(out)
