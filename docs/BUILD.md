# 开发与构建

面向想改代码、自己打包的人。只想用的话去 [README](../README.md) 下载 APK。

## 目录

```
engine/     纯函数排程引擎（零依赖，浏览器和 Node 都能跑）
web/        原生 JS 界面（无框架、无构建步骤）
data/       种子数据（ES 模块）
apk/        WebView 外壳 + 通知 + 手写二进制清单打包
tests/      node:test
tools/      真机脚本、调试客户端、存档备份
```

三条不能破的约束：

1. **引擎不认识 DOM，不认识时钟**：`plan()` 收到的每个时间都是从参数进的，所以能用命令行验证。
2. **不需要打包工具链**：没有 npm install、没有 webpack、没有 Gradle。
3. **改引擎必须先跑测试**：`node --test`。

## 在浏览器里开发

不用每次打包。一条命令起个静态服务：

```bash
cd scheduler && node serve.js
# http://127.0.0.1:8090/web/
```

改完刷新即可。界面加载的就是 `engine/` 里的同一份代码，和 APK 里跑的一模一样。

## 测试

```bash
cd scheduler
node --test tests/*.test.js
```

61 条：25 条引擎规则（不撞课、不重叠、截止日、留白、三种拆分、排序、危机轮、容量、课表周次…）
+ 7 条锁定块 + 7 条跨周滚动 + 2 条版本一致性 + 快照。

push 和 PR 会在 GitHub Actions 里自动跑一遍（`.github/workflows/test.yml`）。

快照锁的是排程输出文本，改动算法后会红——确认是有意为之再更新：

```bash
UPDATE_SNAPSHOT=1 node --test tests/snapshot.test.js
```

性能基准（排程耗时，五个规模档位）：

```bash
node scheduler/tools/bench.mjs
```

真机回归（需要 adb 连着一台设备，会 `pm clear`）：

```bash
powershell -ExecutionPolicy Bypass -File tools/e2e.ps1
```

## 构建 APK

前置：JDK 17+、Node 18+，以及 `tools/` 里的三个 jar（见 `tools/README.md`）。

```bash
# 1. 生成图标
node apk/make-icons.js

# 2. 一键构建 + 签名
./apk/build.sh
```

`apk/build.sh` 会走：`javac` → `r8/D8` 出 dex → `pack.js` 手写二进制 `AndroidManifest.xml`
+ `resources.arsc` + zip → `uas.jar` 签名。

**签名证书和密码都不随仓库提供。** 先生成一张证书：

```bash
keytool -genkeypair -keystore apk/keystore/time-assistant.keystore -alias timeassistant \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass 你的密码 -keypass 你的密码 -storetype PKCS12 \
  -dname "CN=your-name, O=you, C=CN"
```

再提供密码（`build.sh` 不存密码，二选一）：

```bash
export KS_PASS=你的密码          # 方式一：环境变量
```

```ini
# 方式二：apk/keystore.properties（已在 .gitignore 里）
KS_ALIAS=timeassistant
KS_PASS=你的密码
```

路径和别名要改的话：`apk/build.sh` 顶部有 `KS=` 和 `KS_ALIAS` 的默认值，可用同名环境变量覆盖。

### 两种包的区别

| 环境变量 | 效果 | 用途 |
|---|---|---|
| 都不设 | 干净包：无 INTERNET、无 cleartext、无 debuggable | 发版 |
| `TA_DEBUG=1` | 打开 `android:debuggable` | 调试 |
| `TA_DEV=1` | 加 INTERNET + cleartext，加载 `http://127.0.0.1:8090` | 真机边改边看 |

## 存档备份 / 恢复

```bash
node tools/store-io.mjs dump    backup.json
node tools/store-io.mjs restore backup.json
```

**不要把 node 的输出用 PowerShell 管道写文件**：

```powershell
node tools/cdp.mjs "Cosmos.load()" | Out-File backup.json   # 错
```

PowerShell 5.1 会用 ANSI 解码 UTF-8 字节，中文会变成 `é•¿æœŸé¡¹ç›®`，
恢复回去就是脏数据。`store-io.mjs` 用 `execFileSync(..., {encoding:'buffer'})` 绕开这个问题。

## 排障

App 里 **设置 → 诊断 → 复制报告**，把那段贴到 issue 里。报告里有版本号、数据量、
最近几条运行时错误，不含任务内容。
