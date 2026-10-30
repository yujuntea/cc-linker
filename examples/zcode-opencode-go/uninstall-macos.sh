#!/usr/bin/env bash
# uninstall-macos.sh — 停用并移除 opencode_relay 常驻服务
set -euo pipefail
LABEL="com.user.zcode-opencode-relay"
HOME_DIR="$HOME/.zcode/opencode-relay"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "✓ 已停止并取消开机自启"

# 从已安装的 plist 里读回端口（用于提示文案；读不到就用默认值）
# plist 里是 XML：<string>--port</string> 下一行是 <string>8789</string> → 只取数字
PORT="$(grep -A1 -- '<string>--port</string>' "$HOME_DIR/$LABEL.plist" 2>/dev/null | tail -1 | sed 's/[^0-9]//g')"
PORT="${PORT:-8787}"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME_DIR"
  echo "✓ 已删除 $HOME_DIR"
else
  echo "· 保留文件与日志（加 --purge 可一并删除）: $HOME_DIR"
fi

cat <<EOF
注意: 移除代理后，ZCode 里指向 http://127.0.0.1:$PORT/v1 的 provider 会立刻不可用
      （直连 opencode.ai 会在会话里表现为"一直转圈"—— 原因见 README.md §1）。
EOF
