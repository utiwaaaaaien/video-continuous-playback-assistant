#!/bin/zsh
set -eu
helper_dir="${0:A:h}"
extension_id="${1:-}"
if [[ -z "$extension_id" ]]; then
  print '请从 chrome://extensions 复制“视频连续播放助手”的扩展 ID（32 个字母）：'
  read -r extension_id
fi
"$helper_dir/VideoWakeHost" --install "$extension_id"
print '已注册当前用户的 Chrome 本地唤醒组件。组件已复制到 Application Support；请刷新课程页并启用助手。'
