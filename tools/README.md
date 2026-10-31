# tools/

构建 APK 需要三个 jar，体积大，**不放进仓库**。自己放进来：

| 文件 | 从哪来 | 大致大小 |
|---|---|---|
| `android.jar` | Android SDK：`platforms/android-34/android.jar` | 20 MB |
| `r8.jar` | Android SDK build-tools，或 Maven `com.android.tools:r8` | 5 MB |
| `uas.jar` | [uber-apk-signer](https://github.com/patrickfav/uber-apk-signer/releases) 的 jar | 1 MB |

放成 `tools/android.jar`、`tools/r8.jar`、`tools/uas.jar` 即可。
如果用 Android SDK，把 `TP` 指到对应目录也行：

```bash
TP=/path/to/sdk/build-tools/34.0.0 ./apk/build.sh
```
