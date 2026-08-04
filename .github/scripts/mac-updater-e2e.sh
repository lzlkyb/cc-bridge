#!/usr/bin/env bash
# mac 自动更新完整链路真跑：检查 → 下载 → 验签 → 替换 .app → 重启能否启动。
#
# 为什么要真跑：清单 N11 里「更新后打不开」是脉冲式故障——发了才知道，且用户
# 已经升不回去。这种风险不能靠阅代码排除。
#
# 两个关键设计：
#
# 1. **不构建两次**。mac 上一次 tauri build 约 8~10 分钟，跑两次太贵。把现有 .app
#    复制一份、改 Info.plist 版本号并塞一个标记文件，重新签名后打包，就是一个
#    合法的「新版包」。updater 比的是 updater.json 的 version 与运行中应用的版本，
#    所以 json 里写个更高的版本就能触发更新。
#
# 2. **标记文件才是硬证据**。“进程还活着”不能证明替换发生了；只有新包里那个
#    Contents/Resources/CI_UPDATE_MARKER 出现在原位置，才能确定 .app 真的被换了。
#
# 为何必须挂到 GitHub Release：`endpoints()` 在 release 构建下要求 https，而本地自签
# 证书行不通（updater 默认 feature 是 rustls-tls 且未启用 native-roots，把证书加进
# 钥匙串无效）。tag 带 run id 避开并发冲突，标为 prerelease，**跑完即删**。
#
# 用法：mac-updater-e2e.sh <app_path> <bin_path> <signing_key_path>
# 依赖 env：GH_TOKEN / GITHUB_REPOSITORY / GITHUB_RUN_ID / RUNNER_TEMP
set +e
APP="$1"
BIN="$2"
KEY="$3"
if [ -z "$APP" ] || [ -z "$BIN" ] || [ -z "$KEY" ]; then
  echo "usage: mac-updater-e2e.sh <app_path> <bin_path> <signing_key_path>"
  exit 2
fi

TAG="ci-updater-test-${GITHUB_RUN_ID}"
STAGE="$RUNNER_TEMP/newver"
mkdir -p "$RUNNER_TEMP/shots"
NEW="$STAGE/cc-bridge.app"
PKG="$STAGE/cc-bridge-new.app.tar.gz"
MARKER_PATH="Contents/Resources/CI_UPDATE_MARKER"
MARKER="CI-UPDATE-OK-${GITHUB_RUN_ID}"
NEW_VERSION="99.9.9"

cleanup() {
  echo "::group::清理临时 prerelease（不在仓库里留痕）"
  gh release delete "$TAG" --yes --cleanup-tag 2>&1
  echo "delete exit=$?"
  echo "::endgroup::"
}
# 用 trap EXIT 而不是写在末尾：脚本多处会中途 exit，而删 release 必须无论成败都跑到，
# 否则一次失败就会在仓库里留下一个 prerelease。
trap cleanup EXIT

# ── 1) 造「新版包」 ──────────────────────────────────────────
echo "::group::1) 造新版包（改版本号 + 塞标记文件 + 重签 + 打包 + 签名）"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$NEW" || { echo "FAIL 复制 .app 失败"; exit 1; }

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW_VERSION" "$NEW/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_VERSION" "$NEW/Contents/Info.plist"
mkdir -p "$NEW/Contents/Resources"
printf '%s' "$MARKER" > "$NEW/$MARKER_PATH"

# 改了包内容就会破坏原有 ad-hoc 签名，必须重签——否则新包启动不了，
# 那会把「更新后打不开」的原因指错地方。
codesign --force --deep -s - "$NEW" 2>&1
codesign --verify --deep --strict "$NEW" 2>&1
echo "新版包签名校验 exit=$?"

# tar 结构很关键：updater 的 install_inner 用 entry.path().iter().skip(1)，
# 会**跳过第一层路径**。所以包里必须带一层顶层目录（cc-bridge.app/Contents/…），
# 跟 tauri-bundler 自己产出的结构一致。用 -C 切到父目录再打包就是这个形状。
tar -czf "$PKG" -C "$STAGE" cc-bridge.app || { echo "FAIL 打包失败"; exit 1; }
ls -l "$PKG"

# 签名 tar.gz。先把 help 打出来，避免猜 CLI 参数形式猜错白跑一轮。
echo "--- tauri signer sign --help ---"
(cd desktop && npx tauri signer sign --help 2>&1 | head -25)
SIGN_OUT="$STAGE/sign.log"
(cd desktop && npx tauri signer sign -f "$KEY" -p "" "$PKG") > "$SIGN_OUT" 2>&1
if [ ! -f "$PKG.sig" ]; then
  echo "-f 形式未产出 .sig，换 -k 再试（不同 Tauri 版本参数名不同）"
  cat "$SIGN_OUT"
  (cd desktop && npx tauri signer sign -k "$(cat "$KEY")" -p "" "$PKG") >> "$SIGN_OUT" 2>&1
fi
if [ ! -f "$PKG.sig" ]; then
  echo "FAIL 无法为新版包生成签名，后续验签必失败，提前终止"
  cat "$SIGN_OUT"
  exit 1
fi
SIG=$(cat "$PKG.sig")
echo "签名长度=${#SIG}"
echo "::endgroup::"

# ── 2) 挂到临时 prerelease ───────────────────────────────────
echo "::group::2) 挂到临时 prerelease $TAG"
gh release create "$TAG" --prerelease \
  --title "CI 自动更新链路测试（临时，请勿下载）" \
  --notes "由 smoke-macos 作业自动创建用作 https 测试源，跑完即删。run=$GITHUB_RUN_ID" 2>&1
gh release upload "$TAG" "$PKG" "$PKG.sig" --clobber 2>&1

BASE="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG"
cat > "$STAGE/updater.json" <<JSON
{
  "version": "$NEW_VERSION",
  "notes": "CI 自动更新链路测试",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG",
      "url": "$BASE/cc-bridge-new.app.tar.gz"
    }
  }
}
JSON
node -e "JSON.parse(require('fs').readFileSync('$STAGE/updater.json','utf8'));console.log('updater.json 语法 OK')"
gh release upload "$TAG" "$STAGE/updater.json" --clobber 2>&1

ENDPOINT="$BASE/updater.json"
echo "endpoint=$ENDPOINT"
echo "--- 确认该 URL 公开可读（updater 会从这里拉）---"
curl -sIL -o /dev/null -w 'http_code=%{http_code}\n' "$ENDPOINT"
echo "::endgroup::"

# ── 3) 启动旧版并真跑更新 ────────────────────────────────
echo "::group::3) 启动旧版（endpoint 指向临时源）"
# 确认原 .app 里没有标记文件——否则后面的判定就是假的
if [ -f "$APP/$MARKER_PATH" ]; then
  echo "FAIL 原 .app 里已存在标记文件，判定会失真"
  exit 1
fi
echo "原 .app 无标记文件 ✓（判定基线干净）"

pkill -f cc-bridge-desktop 2>/dev/null
sleep 3
CCBRIDGE_UPDATE_ENDPOINT="$ENDPOINT" "$BIN" > "$RUNNER_TEMP/app-upd.log" 2>&1 &
UPD_PID=$!
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:7823/health)
  [ "$code" = "200" ] && { echo "旧版已启动（第 $i 次探测 /health 200）pid=$UPD_PID"; break; }
  kill -0 "$UPD_PID" 2>/dev/null || { echo "FAIL 进程提前退出"; cat "$RUNNER_TEMP/app-upd.log"; exit 1; }
  sleep 1
done
sleep 6
bash .github/scripts/mac-dismiss-dialogs.sh
# 窗口默认 visible:false，再启一次触发 single-instance 把它显示出来
"$BIN" > /dev/null 2>&1
sleep 8
bash .github/scripts/mac-ax-click.sh "$UPD_PID" "跳过引导"
sleep 4
echo "::endgroup::"

echo "::group::4) 找并点「立即更新」"
# 启动会自动检查一次更新，此时应已发现 99.9.9。先把当前按钮名单列出来，
# 再逐个试候选名——真实名称我还没拿到，名单会告诉我们它叫什么。
bash .github/scripts/mac-ax-buttons.sh "$UPD_PID" "启动自检后的窗口（找更新相关按钮）"
CLICKED=""
for NAME in "立即更新" "现在更新" "下载并安装" "立即下载" "更新" "检查更新" "关于 CC Bridge v2.3.20"; do
  R=$(bash .github/scripts/mac-ax-click.sh "$UPD_PID" "$NAME")
  echo "  试 [$NAME] -> $R"
  case "$R" in OK*) CLICKED="$NAME"; sleep 5; bash .github/scripts/mac-ax-buttons.sh "$UPD_PID" "点过 [$NAME] 之后";; esac
done
echo "点到的按钮：[${CLICKED:-无}]"
screencapture -x "$RUNNER_TEMP/shots/08-updater.png" 2>/dev/null
echo "::endgroup::"

echo "::group::5) 等替换完成（标记文件出现即硬证据）"
OK=0
for i in $(seq 1 90); do
  if [ -f "$APP/$MARKER_PATH" ]; then
    echo "✅ 第 ${i}s 发现标记文件 —— .app 真的被替换了"
    echo "  标记内容=$(cat "$APP/$MARKER_PATH")（期望=$MARKER）"
    echo "  新版本号=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
    OK=1
    break
  fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "❌ 90s 内未出现标记文件：替换未发生。应用日志："
  tail -60 "$RUNNER_TEMP/app-upd.log"
fi
screencapture -x "$RUNNER_TEMP/shots/09-after-update.png" 2>/dev/null
echo "::endgroup::"

echo "::group::6) 重启新版 —— N11 的核心问题：更新后能不能打开"
pkill -f cc-bridge-desktop 2>/dev/null
sleep 4
echo "更新后的包签名与 Gatekeeper："
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
echo "  codesign verify exit=$?"
xattr -l "$APP" 2>&1
echo "  （上面为空 = 无 quarantine，这正是「更新后不会被 Gatekeeper 拦」的关键）"
"$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")" > "$RUNNER_TEMP/app-after-upd.log" 2>&1 &
NEW_PID=$!
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:7823/health)
  if [ "$code" = "200" ]; then
    echo "✅ 更新后重启成功，/health 200（第 ${i}s）—— N11 的核心风险不成立"
    break
  fi
  kill -0 "$NEW_PID" 2>/dev/null || { echo "❌ 更新后的包启动即退出！日志："; cat "$RUNNER_TEMP/app-after-upd.log"; break; }
  sleep 1
done
[ "$code" != "200" ] && echo "❌ 更新后 40s 内 /health 未就绪（这就是 N11 担心的那个故障）"
pkill -f cc-bridge-desktop 2>/dev/null
echo "::endgroup::"

echo "::group::应用日志（更新过程）"
tail -80 "$RUNNER_TEMP/app-upd.log" 2>/dev/null
echo "::endgroup::"
