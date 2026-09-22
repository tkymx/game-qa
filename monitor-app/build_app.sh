#!/usr/bin/env bash
# JevQAMonitor を .app バンドルとしてビルドする(裸のSPM実行ファイルのままだと
# Launch Services に登録されず、Dockやアプリ一覧に出てこないため)。
# 使い方: bash build_app.sh
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release

APP="JevQAMonitor.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/JevQAMonitor "$APP/Contents/MacOS/JevQAMonitor"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>JevQAMonitor</string>
  <key>CFBundleDisplayName</key><string>Jev QA Monitor</string>
  <key>CFBundleIdentifier</key><string>dev.game-qa.monitor</string>
  <key>CFBundleExecutable</key><string>JevQAMonitor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

echo "built: $(pwd)/$APP"
