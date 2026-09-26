#!/bin/bash
set -u

APP_PATHS=(
  "/Applications/WorldBase.app"
  "$HOME/Applications/WorldBase.app"
)

for app_path in "${APP_PATHS[@]}"; do
  if [[ -d "$app_path" ]]; then
    echo "正在修复并打开：$app_path"
    if ! /usr/bin/xattr -dr com.apple.quarantine "$app_path"; then
      echo "无法移除 WorldBase.app 的隔离标记。请确认你有权限，并且应用来自可信来源。"
      read -r -n 1 -s -p "按任意键退出..."
      echo
      exit 1
    fi

    /usr/bin/open "$app_path"
    exit $?
  fi
done

echo "未找到已安装的 WorldBase.app。请先将 WorldBase 拖入 Applications 文件夹，再运行此脚本。"
read -r -n 1 -s -p "按任意键退出..."
echo
exit 1
