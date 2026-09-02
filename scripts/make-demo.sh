#!/bin/bash
# 重新生成 docs/ 自举演示图（用 tushi 画 tushi 自己的工作管线）
# 用法: bash scripts/make-demo.sh
# 依赖: java + plantuml.jar（tushi.py 会自动定位/下载）

set -e
cd "$(dirname "$0")/.."

OUT=docs/demo
mkdir -p "$OUT"
cp "$OUT/tushi.puml" /tmp/tushi-demo.puml 2>/dev/null || true
cp "$OUT/tushi.notes.json" /tmp/tushi-demo.notes.json 2>/dev/null || true

python3 scripts/tushi.py render \
  --puml "$OUT/tushi.puml" \
  --notes "$OUT/tushi.notes.json" \
  --title "图示 tushi 自举图"

echo ""
echo "✅ demo 已更新: $OUT/index.html"
echo "   交互版地址（GitHub Pages）: https://h2o502.github.io/tushi/"
echo "   提交后 README 里的静态图 (tushi.svg) 同步更新"
