#!/usr/bin/env python3
"""
tushi（图示）— PlantUML → 可交付交互式架构图

把 .puml 渲染成 SVG，叠加白话注释热区，拼装成单文件 HTML：
零依赖、零网络请求，浏览器打开即用，可直接分享。

用法：
  python3 tushi.py render --puml diagram.puml [--notes diagram.notes.json]
                          [--out outdir/] [--title 标题]

产物（--out 目录，默认 puml 同目录）：
  index.html      ← 交付物：单文件交互页面（发给用户的就是它）
  diagram.puml    ← 源（git 可 diff，手改后重渲染）
  diagram.svg     ← PlantUML 原始渲染底图
  diagram.notes.json ← 白话注释 sidecar（可选）

notes JSON 格式：
  { "notes": [
      { "key": "锚点文本",          // 匹配 SVG <text>；多锚点用 "keys": [...]
        "mode": "prefix",          // exact|prefix|contains|regex，默认 prefix
        "title": "浮层标题",
        "body": "HTML 正文" } ] }

渲染后端：PLANTUML_JAR 环境变量 > 脚本同目录 ../vendor/plantuml.jar >
/usr/local/bin/plantuml.jar。java 由 PATH 提供。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_DIR = HERE.parent
APP_DIR = SKILL_DIR.parent          # app 内时：tushi/skill/ → tushi/
# viewer 优先 skill 自带（开源独立可用），其次 app 共享（tushi/viewer/）
_VIEWER_CANDIDATES = [
    SKILL_DIR / "viewer" / "puml-viewer.js",
    APP_DIR / "viewer" / "puml-viewer.js",
]
VIEWER_JS = next((p for p in _VIEWER_CANDIDATES if p.is_file()), _VIEWER_CANDIDATES[0])


JAR_MAVEN = "https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/1.2025.4/plantuml-1.2025.4.jar"
JAR_VERSION = "1.2025.4"


def download_jar(dest: Path) -> Path:
    """自动下载 plantuml.jar 到 vendor/ 目录（首次使用，约 22MB）"""
    import urllib.request
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"tushi: 正在下载 PlantUML {JAR_VERSION}（约 22MB，仅此一次）…")
    urllib.request.urlretrieve(JAR_MAVEN, dest)
    print(f"tushi: 已下载 {dest}")
    return dest


def find_jar() -> Path:
    cand = []
    env = os.environ.get("PLANTUML_JAR")
    if env:
        cand.append(Path(env))
    cand += [
        SKILL_DIR / "vendor" / "plantuml.jar",
        APP_DIR / "vendor" / "plantuml.jar",     # app 内共享（tushi/vendor/）
        Path("/usr/local/bin/plantuml.jar"),
        Path("/usr/share/java/plantuml.jar"),
    ]
    for c in cand:
        if c.is_file():
            return c
    raise SystemExit(
        f"未找到 plantuml.jar。任选其一：\n"
        f"  1) 自动下载（推荐，约 22MB 一次即可）:\n"
        f"     mkdir -p {SKILL_DIR / 'vendor'} && curl -L -o {SKILL_DIR / 'vendor' / 'plantuml.jar'} {JAR_MAVEN}\n"
        f"  2) export PLANTUML_JAR=/path/to/plantuml.jar\n"
        f"  3) 放到系统路径 /usr/local/bin/plantuml.jar\n"
        f"  需要同时安装 Java 运行时（JRE 11+）。"
    )


def render_svg(jar: Path, puml_file: Path) -> str:
    """渲染 puml → svg 文本；失败时把 PlantUML 报错抛给调用方（喂回 LLM 修正）。"""
    p = subprocess.run(
        ["java", "-Duser.home=/tmp", "-jar", str(jar), "-tsvg",
         "-charset", "UTF-8", str(puml_file)],
        capture_output=True, text=True, timeout=120,
        cwd=str(puml_file.parent))
    svg_file = puml_file.with_suffix(".svg")
    if p.returncode != 0 or not svg_file.exists():
        err = (p.stderr or p.stdout or "").strip()
        raise RuntimeError("plantuml 渲染失败:\n" + "\n".join(err.splitlines()[-12:]))
    return svg_file.read_text(encoding="utf-8")


def js_safe(s: str) -> str:
    """内联进 <script> 的 JS 源码防提前终止（注释/字符串里的字面量转义）。"""
    return s.replace("</script", "<\\/script").replace("</div", "<\\/div")


def build_single_file(svg: str, notes: dict, viewer: str, title: str) -> str:
    notes_json = json.dumps(notes, ensure_ascii=False) if notes else ""
    notes_json = notes_json.replace("</", "<\\/")  # JSON 合法转义，防 script 提前终止
    title = title.replace("&", "&amp;").replace("<", "&lt;")
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>html,body{{margin:0;padding:0;height:100%}}</style>
</head>
<body>
<div id="pv-inline-svg" style="display:none">{svg}</div>
<script type="application/json" id="pv-notes-data">{notes_json}</script>
<script>
{js_safe(viewer)}
</script>
</body>
</html>
"""


def cmd_render(args):
    puml_file = Path(args.puml).resolve()
    if not puml_file.is_file():
        raise SystemExit(f"puml 文件不存在: {puml_file}")
    out_dir = Path(args.out).resolve() if args.out else puml_file.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # puml / notes 复制进产物目录（单文件自包含，源文件随行）
    out_puml = out_dir / puml_file.name
    if puml_file != out_puml:
        shutil.copy2(puml_file, out_puml)

    notes_path = Path(args.notes).resolve() if args.notes else puml_file.with_suffix(".notes.json")
    notes = None
    if notes_path.is_file():
        notes = json.loads(notes_path.read_text(encoding="utf-8"))
        out_notes = out_dir / notes_path.name
        if notes_path != out_notes:
            shutil.copy2(notes_path, out_notes)

    try:
        jar = find_jar()
    except SystemExit:
        if not args.auto_install:
            raise
        # 优先 app vendor（app 内共享），否则落 skill vendor
        jar = download_jar((APP_DIR if APP_DIR.name == "tushi" and (APP_DIR / "vendor").is_dir()
                            else SKILL_DIR) / "vendor" / "plantuml.jar")
    svg = render_svg(jar, out_puml)  # svg 落在 out_dir，与 puml 同名
    viewer = VIEWER_JS.read_text(encoding="utf-8")
    title = args.title or out_puml.stem

    html = build_single_file(svg, notes, viewer, title)
    index = out_dir / "index.html"
    index.write_text(html, encoding="utf-8")

    n = len(notes["notes"]) if notes else 0
    print(f"tushi 完成: {index}")
    print(f"  底图 {out_puml.stem}.svg · 白话注释 {n} 条 · 单文件 {len(html) // 1024}KB")
    print(f"  交付: 用浏览器打开 index.html（或部署后给 URL）")


def main():
    ap = argparse.ArgumentParser(prog="tushi", description="tushi 图示 — PlantUML → 交互式单文件 HTML")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render", help="渲染 puml 为可交付单文件 HTML")
    r.add_argument("--puml", required=True, help="PlantUML 源文件")
    r.add_argument("--notes", help="白话注释 sidecar JSON（默认 <puml>.notes.json）")
    r.add_argument("--out", help="产物目录（默认 puml 同目录）")
    r.add_argument("--title", help="页面标题（默认 puml 文件名）")
    r.add_argument("--auto-install", action="store_true",
                   help="未找到 plantuml.jar 时自动下载到 vendor/（约 22MB，仅一次）")
    r.set_defaults(func=cmd_render)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
