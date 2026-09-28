#!/bin/bash

set -e

APP_NAME="weflow"
APP_EXEC="weflow"
OPT_DIR="/opt/$APP_NAME"
BIN_LINK="/usr/bin/$APP_NAME"
DESKTOP_DIR="/usr/share/applications"
ICON_DIR="/usr/share/pixmaps"

if [ "$EUID" -ne 0 ]; then
  echo "❌ 请使用 root 权限运行此脚本 (例如: sudo ./install.sh)"
  exit 1
fi

echo "🚀 开始安装 $APP_NAME..."

echo "📦 正在复制文件到 $OPT_DIR..."
rm -rf "$OPT_DIR"
mkdir -p "$OPT_DIR"
cp -r ./* "$OPT_DIR/"
chmod -R 755 "$OPT_DIR"
chmod +x "$OPT_DIR/$APP_EXEC"

echo "🔗 正在创建软链接 $BIN_LINK..."
ln -sf "$OPT_DIR/$APP_EXEC" "$BIN_LINK"

echo "📝 正在创建桌面快捷方式..."
cat <<EOF >"$DESKTOP_DIR/${APP_NAME}.desktop"
[Desktop Entry]
Name=WeFlow
Exec=$OPT_DIR/$APP_EXEC %U
Terminal=false
Type=Application
Icon=$APP_NAME
StartupWMClass=WeFlow
Comment=A local WeChat database decryption and analysis tool
Categories=Utility;
EOF
chmod 644 "$DESKTOP_DIR/${APP_NAME}.desktop"

echo "🖼️ 正在安装图标..."
if [ -f "$OPT_DIR/resources/icon.png" ]; then
  cp "$OPT_DIR/resources/icon.png" "$ICON_DIR/${APP_NAME}.png"
  chmod 644 "$ICON_DIR/${APP_NAME}.png"
elif [ -f "$OPT_DIR/icon.png" ]; then
  cp "$OPT_DIR/icon.png" "$ICON_DIR/${APP_NAME}.png"
  chmod 644 "$ICON_DIR/${APP_NAME}.png"
else
  echo "⚠️ 警告: 未找到图标文件，跳过图标安装。"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  echo "🔄 更新桌面数据库..."
  update-desktop-database "$DESKTOP_DIR"
fi

echo "✅ 安装完成！你现在可以在应用菜单中找到 WeFlow，或者在终端输入 'weflow' 启动。"
