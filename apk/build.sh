#!/usr/bin/env bash
# 一键构建「排程」APK（无 Android SDK：清单与资源表由 pack.js 手写生成）
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${TP:-}" ]; then
  if [ -f ../tools/android.jar ]; then TP=../tools; else TP=../build/tools; fi
fi

echo "[1/4] 编译"
rm -rf build/classes build/out/unsigned && mkdir -p build/classes
javac -source 8 -target 8 -encoding UTF-8 -nowarn \
      -cp "$TP/android.jar" -d build/classes \
      src/ai/cosmos/timeassistant/*.java 2>&1 | grep -v "^警告\|^warning\|bootstrap class path" || true

echo "[2/4] dex"
java -cp "$TP/r8.jar" com.android.tools.r8.D8 --release --min-api 26 \
     --lib "$TP/android.jar" --output build \
     $(find build/classes -name '*.class')

echo "[3/4] 图标 + 打包"
node make-icons.js
node pack.js

echo "[4/4] 签名"
mkdir -p build/out
# 密码不进仓库：优先读 apk/keystore.properties（已 ignore），其次读环境变量。
# 例：apk/keystore.properties 里写  KS_ALIAS=timeassistant / KS_PASS=xxxx
KS=keystore/time-assistant.keystore
if [ -f keystore.properties ]; then . ./keystore.properties; fi
ALIAS=${KS_ALIAS:-timeassistant}
if [ -f "$KS" ]; then
  if [ -z "${KS_PASS:-}" ]; then
    echo "缺签名密码：export KS_PASS=... 或在 apk/keystore.properties 里写 KS_PASS=..." >&2
    exit 1
  fi
  rm -rf build/out/signed
  java -jar "$TP/uas.jar" -a build/out/scheduler-unsigned.apk -o build/out/signed --skipZipAlign \
       --ks "$KS" --ksAlias "$ALIAS" \
       --ksPass "$KS_PASS" --ksKeyPass "${KS_KEY_PASS:-$KS_PASS}"
  cp build/out/signed/scheduler-signed.apk "../time-assistant.apk"
  ls -lh ../time-assistant.apk
else
  echo "没有 keystore/，只产出未签名包：build/out/scheduler-unsigned.apk"
  echo "自己生成一张证书后再跑一次即可（见 README）。"
fi
