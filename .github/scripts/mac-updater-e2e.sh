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
# 密钥：签名私钥必须与**应用内置的 pubkey**配对。烟测用一次性密钥，所以 workflow 会在
# tauri build 之前把配对公钥写进 tauri.conf.json。我最初以为「公钥对不上只影响客户端
# 校验」——那只在只验打包时成立，验更新链路时验签就是核心环节，这个错误前提让我白跑三轮。
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

# The production updater requires the package signature to bind the advertised version.
SIGN_OUT="$STAGE/sign.log"
if ! (cd desktop && npx tauri signer sign -f "$KEY" -p "" --app-version "$NEW_VERSION" "$PKG") > "$SIGN_OUT" 2>&1; then
  echo "Could not sign the test update"
  exit 1
fi
SIG=$(cat "$PKG.sig")
echo "签名长度=${#SIG}"

# 前置检查：签名用的私钥必须与**应用内置的公钥**配对。
# 为何单列一步：这正是前三轮失败的原因——包能下载、但 updater 报
# "The signature was created with a different key than the one provided"，
# 而那个错误只在应用日志里（得开 RUST_LOG 才看得到），白跑了三轮。
# 在这里提前对比两个公钥，不匹配就直接红，而不是等 90s 超时后猜原因。
CONF_PUB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('desktop/src-tauri/tauri.conf.json','utf8')).plugins.updater.pubkey)")
# 注意：`tauri signer generate` 产出的 .pub 文件内容**本身就是 base64**，
# 不能再编一次（双重编码会让比对永远不相等，且构建侧会直接报
# "Missing encoded key in public key"）。同样按内容自动判断。
KEY_PUB=$(node -e "
  const fs=require('fs'), f=process.argv[1];
  if(!fs.existsSync(f)){ process.exit(0); }
  const raw=fs.readFileSync(f,'utf8').replace(/\s+/g,'');
  let out;
  try {
    out = Buffer.from(raw,'base64').toString('utf8').startsWith('untrusted comment')
      ? raw
      : fs.readFileSync(f).toString('base64');
  } catch (e) { out = fs.readFileSync(f).toString('base64'); }
  process.stdout.write(out);
" "$KEY.pub" 2>/dev/null)
if [ -z "$KEY_PUB" ]; then
  echo "⚠ 找不到 $KEY.pub，无法比对公钥（不终止，但若后面验签失败先查这里）"
elif [ "$CONF_PUB" = "$KEY_PUB" ]; then
  echo "✅ 签名密钥与应用内置公钥配对（验签不会因密钥不匹而失败）"
else
  echo "❌ 密钥不配对！应用内置公钥与签名私钥不是一对，验签必失败，提前终止。"
  echo "  配置里 pubkey 前 24 字符：${CONF_PUB:0:24}…"
  echo "  签名密钥公钥前 24 字符：${KEY_PUB:0:24}…"
  echo "  修法：在 tauri build **之前**把 $KEY.pub 的 base64 写进 tauri.conf.json 的"
  echo "        plugins.updater.pubkey（pubkey 会被编译进二进制，事后改无效）。"
  exit 1
fi
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
# 开 updater 的详细日志：`start_update` 失败时只发 Tauri event 给前端、**不写日志**，
# 上一轮因此拿到的 app-upd.log 是空的、什么也没查到。updater 内部有 log::debug!，
# 把级别降下来就能看到它到底请求了什么、拿到什么。
RUST_LOG="info,tauri_plugin_updater=trace" CCBRIDGE_SKIP_FORCE_UPDATE=1 CCBRIDGE_UPDATE_ENDPOINT="$ENDPOINT" "$BIN" > "$RUNNER_TEMP/app-upd.log" 2>&1 &
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

echo "::group::4) 准备安装包并确认安装"
click() {
  local result
  result=$(bash .github/scripts/mac-ax-click.sh "$UPD_PID" "$1")
  case "$result" in OK*) echo "$result"; return 0;; esac
  return 1
}

# Preparation may have finished in the background before the window appeared.
click "下载更新" || true
for attempt in $(seq 1 35); do
  if [ -f "$APP/$MARKER_PATH" ]; then
    echo "The app was replaced before installation was confirmed"
    exit 1
  fi
  if click "立即更新"; then
    break
  fi
  click "已就绪" || click "查看更新" || click "下载更新" || true
  sleep 2
done

installed=0
for i in $(seq 1 45); do
  if [ -f "$APP/$MARKER_PATH" ] && [ "$(cat "$APP/$MARKER_PATH")" = "$MARKER" ]; then
    installed=1
    break
  fi
  sleep 1
done
screencapture -x "$RUNNER_TEMP/shots/08-updater.png" 2>/dev/null
if [ "$installed" != 1 ]; then
  bash .github/scripts/mac-ax-buttons.sh "$UPD_PID" "安装确认后未看到新版标记"
  tail -80 "$RUNNER_TEMP/app-upd.log"
  exit 1
fi
codesign --verify --deep --strict "$APP" || exit 1
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$NEW_VERSION" || exit 1
echo "::endgroup::"

echo "::group::5) 由更新界面重启，并确认新进程可用"
click "重启并体验" || { click "重启" && sleep 2 && click "重启并体验"; } || exit 1
for i in $(seq 1 45); do
  # Checking service availability before the old PID exits can mistake it for the new app.
  if ! kill -0 "$UPD_PID" 2>/dev/null && curl -fsS --max-time 2 http://127.0.0.1:7823/health >/dev/null; then
    echo "Updated bundle relaunched and answered /health"
    screencapture -x "$RUNNER_TEMP/shots/09-after-update.png" 2>/dev/null
    echo "::endgroup::"
    exit 0
  fi
  sleep 1
done
tail -80 "$RUNNER_TEMP/app-upd.log"
echo "Updated application did not relaunch"
exit 1
