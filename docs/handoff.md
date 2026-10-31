# 交接说明

> 给接手这个项目的 AI 或开发者。读完这一份就能继续干，不用翻聊天记录。

## 这是什么

`time-assistant`：一个会**替你排具体时段**的学生任务管理器，Android 应用，包名 `ai.cosmos.timeassistant`。

用户填任务（重要度星级、预计时长、截止时间），它结合课表和每日可用时段，把任务排进未来 7 天，到点发通知。

和普通待办的区别：多算一个「可行性压力」——不是「离截止还有几天」，而是「剩余工作量 ÷ 截止前你真正还有多少空档」。所以「三天后交但你这三天只有 4 小时空」比「下周交但下周很空」更急。

## 现在到哪一步了

| 项 | 状态 |
|---|---|
| 版本 | 0.9（versionCode 9） |
| APK 体积 | 138 KB |
| 测试 | 24 条，全绿 |
| 上架 | 没有，自用 + 准备开源 |
| 平台 | Android，minSdk 26 / targetSdk 34 |

已经能日常用的部分：录任务、自动排程、跨周滚动、打勾、超时确认、系统通知、统计、主题、诊断日志。

## 三个铁律（先记住这个，其余都能查）

1. **引擎不认识 DOM，界面不认识排程。**
   `scheduler/engine/` 是纯函数，输入 state 输出 plan，没有任何浏览器 API。
   这条边界是「改逻辑不用开浏览器、改样式不用跑测试」的前提，别破坏。

2. **不引入构建工具、框架、第三方 SDK。**
   没有 npm 依赖、没有 webpack、没有 Gradle、没有 androidx。
   当前 138 KB 的体积就是这么来的。加一个 React 或一个推送 SDK，体积立刻十几 MB。

3. **改引擎必须跑测试；快照变了要确认是有意的。**
   `node --test tests/*.test.js`。快照测试锁的是排程输出的纯文本。

## 目录

```
scheduler/
  engine/plan.js     排程核心（打分、装箱、trace）
  engine/time.js     区间代数（并、差、裁剪）
  engine/render.js   纯文本渲染，给命令行和快照测试用
  engine/cli.js      命令行入口
  web/index.html     界面骨架
  web/app.js         全部界面逻辑（约 1500 行）
  web/roll.js        跨周滚动：起点跟今天走 + 历史记录位移（纯函数，可测）
  web/style.css      全部样式
  web/fonts/         Inter 四个字重（只覆盖拉丁和数字）
  version.js         版本号唯一来源（VERSION / VERSION_CODE，pack.js 用正则读它）
  data/app-seed.json 首次启动灌入的数据（中性示例课表）
  data/seed.js       由 app-seed.json 转成的 ES 模块
  data/week6.json    测试用的 fixture（带任务的）
  tests/             26 条测试 + 快照
apk/
  src/ai/cosmos/timeassistant/   4 个 Java 类
  res/mipmap/                    图标（脚本生成）
  pack.js                        手写二进制 AndroidManifest + resources.arsc + zip
  build.sh                       一键构建（签名密码从 keystore.properties / KS_PASS 读）
  make-icons.js                  生成图标（纯 Node，无图像库）
docs/screenshots/                截图
.github/workflows/test.yml       CI：push / PR 跑语法检查 + 全部测试
.github/ISSUE_TEMPLATE/          用户反馈模板（要求贴「设置→诊断→复制报告」的内容）
```

## 怎么跑

**浏览器里开发（改界面用这个，快）**

```bash
cd scheduler && node serve.js
# http://127.0.0.1:8090/web/
```

改完刷新即生效，不用重新打包。界面加载的就是 `engine/` 里的同一份代码。

**跑测试**

```bash
cd scheduler && node --test tests/*.test.js
```

**打 APK**

需要 JDK 17+、Node 18+，以及 `tools/` 下的三个 jar（见 `tools/README.md`）。

```bash
node apk/make-icons.js     # 只有改图标时需要
./apk/build.sh
```

流程：`javac` → `r8/D8` 出 dex → `pack.js` 组装 → `uas.jar` 签名。

签名证书在 `apk/keystore/time-assistant.keystore`，**不进仓库**，别人要用得自己生成一张（README 有命令）。
密码也不进仓库：`build.sh` 从 `apk/keystore.properties` 或 `KS_PASS` 环境变量读。

## 排程算法

核心就三个数，都在 `engine/plan.js`：

```
R = 剩余工作量（分钟）
A = 从现在到截止，真正能用的空档（已扣课表、已扣留白），最多往后看 120 天
p = R / A
u = 1 − e^(−1.8·p)          紧急度
i = ((星级 − 1) / 4) ^ 0.8   重要度
score = w·i + (1 − w)·u      w 默认 0.45，界面上是一根滑杆
```

排序后一个一个往下放，每放一块重算所有任务的 A（动态优先级）。
`slack = A − R < 0` 的任务进「危机轮」，不参与打分，最先排。

几条容易忘的规则：

- **留白**：每天最多用掉当天空档的 85%（`fillRatio`）。但**当天的第一块不受限**——否则「只有 1 小时空、任务正好 1 小时」的日子会既排不上又白留 15%。
- **课后缓冲**：每个固定块前后各留 10 分钟（`classBufferMin`），因为要换教室。
- **排程跨度**：由 `app.js` 的 `computeSpan()` 按最远截止日算（至少 7 天、最多 120 天），通过 `rules.spanDays` 传给引擎。以前写死 7 天，「20 天后交」的任务永远排不进来。
- **块间休息**：`clamp(块长/6, 5, 20)` 分钟。
- **三种拆分**：`none` 不可拆 / `free` 系统按空档切 / `fixed` 用户定「每次 X 分钟 × N 次」。

## 数据结构

一个 JSON，存在 app 私有目录的 `time-assistant-v1.json`，通过 JS 桥读写。

```jsonc
{
  "startDate": "2026-10-30",      // 排程起点（今天）
  "horizonDays": 7,
  "semester": { "startDate": "2026-09-21", "totalWeeks": 17, "enabled": true },
  "template": { "1": [[480, 710], [780, 1050], [1140, 1290]] },  // 按星期几的可用时段
  "fixed": [                       // 固定占用
    { "kind": "semester", "label": "高等代数I", "weekday": 1, "start": 610, "end": 720, "weeks": "1-17" },
    { "kind": "weekly",   "label": "社团", "weekdays": [1, 3, 5], "start": 1140, "end": 1260 },
    { "kind": "once",     "label": "活动", "date": "2026-11-05", "start": 840, "end": 960 }
  ],
  "tasks": [{
    "id": "t1", "title": "第三章习题", "course": "线性代数",
    "stars": 5, "estMin": 180, "doneMin": 0,
    "deadlineDate": "2026-11-06", "deadlineAt": 1439,   // 分钟数
    "split": { "mode": "free", "minChunkMin": 45, "maxChunks": 3, "maxChunksPerDay": 2 }
  }],
  "log": [{ "taskId": "t1", "day": 0, "start": 930, "end": 1050, "minutes": 120, "actualMin": 95, "at": 1761, "kind": "done" }],
  "pending": [],                   // 到点没打勾的段，等用户处理
  "lastPlan": [],                  // 上一版计划，用来发现「过期未处理」
  "diag": [],                      // 诊断日志环形缓冲
  "theme": "indigo"
}
```

时间一律用**当天分钟数**表示（`19:30` → 1170），不做 UTC 换算。

### 主题：配色型 vs 风景型

`THEMES` 里有两类：

- **配色型**（靛蓝/紫罗兰/青碧/蔷薇/琥珀）：只有 `a`/`b` 两个颜色，走原来的渐变强调。
- **风景型**（海岸/雪原/丹顶鹤/柴犬）：额外带 `bg`（CSS 渐变）、`art`（`BG_ART` 里的 SVG 剪影）、`ink`（剪影颜色）。
  `applyTheme()` 会设置 `html[data-scene]` 并把渐变写到 `#bg`、剪影写进 `#bg-art`。
  切回配色型时把 `data-scene` 删掉、清空 `#bg`/`#bg-art`，界面完全回到原样。

**刻意不含任何图片**：剪影都是手写 SVG 路径，全套不到 6 KB。为什么不内置图片：
版权（梗图/动漫角色/图库素材各有各的坑）、体积（一张图就顶现在整个 APK）、会过时。
真要图片，走「用户自己选」而不是内置。

`#bg` 是 `position:fixed; z-index:-1`，所以 `html[data-scene]` 必须把 `html`/`body` 的背景设为透明，
否则会把渐变盖住。考卷模式下 `#bg` 会被 `skin-exam.css` 隐藏。
### 计划编辑（pin）：用户改过的块必须被尊重

排程是**每次全量重算**的（启动 / 切回前台 / 每 5 分钟 / 每次操作）。所以用户在计划页做的任何修改，
如果不落成数据，下一次 rebuild 就会被算回去。

`store.pins = [{ taskId, day, date, start, end }]` 就是这份数据：

- **引擎**：`makeState()` 把 pin 的时长从 `remain` 里扣掉，`plan()` 开头先把 pin 塞进 `placed`。
  于是 `freeOf()` 自动绕开它们，其余任务照常贪心往下排。
- **校验**（`checkPlanEdit`）：不早于现在、不撞课（含缓冲）、不与其他块重叠、不超任务总量、不出窗口。
  不合法就返回文案，弹层不关，让用户改。
- **进行中的块禁止改开始时间**：否则 `actualMin = 打勾时刻 − 块开始时刻` 会算错。这条是唯一的硬边界。
- **完成 / 删任务时清 pin**：不清就会重复扣时长。
- **跨周滚动**：`roll.js` 的 `LISTS` 里已经带上 `pins`，和 log/pending 一样迁移。

测试在 `tests/pins.test.js`（7 条）+ `tests/roll.test.js` 里的一条迁移测试。
### 左右滑动切页

`TAB_ORDER` 定义顺序（现在→计划→任务→统计→设置）。手势挂在 `document` 上：

- `touchstart` 记录起点，落在 `.sheet` / `.confirm` / 输入框 / `.chips` / `.seg` 里直接放弃
- `touchmove` 先判方向：横向分量 > 纵向 1.15 倍才接管，否则 `swipe = null`，把手势还给滚动
- 拖动时直接改 `#app` 的 `translateX`（`transition: none`），首尾给 0.28 阻尼
- `touchend` 判定：位移超过 `min(90px, 宽度*22%)` 且存在相邻页才切，否则回弹
- 切页用 `slideTo()`：滑出 → `paint()` → 从另一侧滑入

**为什么不做「双页同时渲染」**：那要改渲染架构（把 paint 变成多页缓存），代价远大于收益。
现在的方案只有一个页面在 DOM 里，拖动时背后是背景色，视觉上可以接受。

`paint()` 开头会清掉 `#app` 的 transform，避免切页动画中途点标签导致内容错位。

**注意**：手势只监听 touch 事件，电脑浏览器里用鼠标拖不会触发（真机才有效）。### 界面风格：普通 / 玻璃 / 考卷（`uiMode`）

`store.uiMode` 有三个值：`plain`（默认）、`glass`、`exam`。实现是同一套「可拆卸外挂」：
`applySkin()` 按值往 `<head>` 插对应的 `skin-*.css`，并给 `<html>` 打 `data-ui`，切换时删掉不用的那个。

- `skin-glass.css`：照设计稿做的浅色毛玻璃风（雾蓝 #7FA8C9 + 薄荷 #9FD3C7，圆角 28，24px 模糊，
  1px 白色内描边）。**文字改成深墨绿**——稿子里白字压浅玻璃对比度只有约 1.5:1，实际看不清。
- `skin-exam.css`：考卷模式，另外还带三个 JS 分支（空状态/盖章/错题卡）。

两个坑：
1. `applyTheme()` 把颜色写成**行内变量**，皮肤里覆盖变量必须加 `!important`，否则不生效。
2. 玻璃/考卷模式下主题卡置灰（配色固定），否则用户点了没反应会以为坏了。
### 实验功能：考卷模式（`uiMode`）

`store.uiMode` 只有两个值：缺省/`plain`（正常界面）和 `exam`（考卷皮肤）。

皮肤是**可拆卸外挂**：`applySkin()` 在开启时往 `<head>` 插一个 `<link href="skin-exam.css">`，
同时给 `<html>` 加 `data-ui="exam"`；关掉就删 link、去掉属性，**界面完全回到原样**。
`skin-exam.css` 的样式全部写在 `html[data-ui='exam']` 下面，不加载就零影响。

三个局部改动都走同一个开关，且各自是独立小分支，主线渲染没动：
空状态（`renderNow` 里的空白试卷）、完成盖章（`flashStamp()`）、待处理卡片（错题样式 + 文案）。
贴纸层是绝对定位的 `pointer-events:none` 装饰，不占布局。

**注意**：`applyTheme()` 写的是行内 CSS 变量，所以皮肤文件里覆盖变量必须用 `!important`。
新增皮肤只要再写一个 `skin-xxx.css` + 在 `applySkin()` 里加一个分支即可。

### 数据安全（别退回去）

只有一个 JSON，但它丢不起。现在的防线是四层，改代码时别拆：

1. **原子写**：`MainActivity.save()` 先写 `DATA_FILE + ".tmp"`、`fsync`，再 `rename` 覆盖。
   进程被杀或掉电最多留下 `.tmp`，原存档完好。**不要改回直接 `FileOutputStream(target)`。**
2. **备份**：每次成功保存前，把上一份拷成 `.bak`。
3. **坏档不覆盖**：`readStore()` 返回 `empty / ok / corrupt` 三态。`corrupt` 时先试 `.bak`；
   都不行就 `storageLocked = true`，顶部出红条（导出原始数据 / 从备份恢复 / 清空重来），
   期间 `writeStore()` 直接 return。
   老版本会把坏档当「首次启动」灌种子数据——用户就是这么无提示地丢过一次全部数据。
4. **导入**：`importText()` 校验 `tasks` 是数组、`template` 是对象才接受。

从备份恢复时要先调 `discardPrimary()`：否则紧接着的 `save()` 会把坏掉的主存档复制进 `.bak`，
把唯一的好备份冲掉。

## 已经踩过的坑（别再踩）

1. **日期必须是 `YYYY-MM-DD`。** 曾经 CLI 里用 `MM-DD`，导致 `Date.parse` 得 `NaN`，整张课表静默消失，而测试全绿——因为测试只测引擎不测输出。所以才有 `render.js` 和快照测试。

2. **`el(html)` 只返回第一个元素。** 模板有多个根节点时，`querySelector` 会拿到 `null`，引发「Cannot read properties of null」。现在 `el()` 遇到多根会包一层 div 兜底，但写新模板时仍要注意。

3. **时钟曾经冻结。** `const realNow = new Date()` 只在页面加载时取一次，导致「距开始 4m」永远不变。现在一律用 `nowMinute()` / `nowDayIdx()` 现取，并且每 30 秒刷新界面、每 5 分钟重排。

4. **WebView 里 `file://` 不能用 ES 模块。** 会被 CORS 挡死、白屏。现在的做法是拦截 `http://appassets.local/`，从 assets 读文件，模块和 fetch 都能用。

5. **`Date.parse('2026-10-30T00:00:00Z')` vs 本地时区。** 日期计算统一走 UTC 零点，避免时区漂移。界面上用 `new Date(str + 'T00:00:00')` 解析本地时间，两处别混。

6. **小米会报「包含病毒 a.gray.devicemaster」。** 这是公共 debug 证书的灰名单误报，不是真病毒。现在已换成自签名证书，仍可能报，属正常。

7. **相对 `day` 可以是负数。** 跨周滚动后，过去的记录和待处理块 `day` 会变成负的。所以凡是「显示星期几」
   「跟今天比」「算按时率」的地方，一律从绝对 `date` 推，别再 `wdOf(day)` / `dateOf(day)`——`((wd-1+d)%7)+1`
   遇到负数会算出 `WD[-2]`，界面直接显示 `undefined`。新写入 `log` / `pending` 时都带上 `date`
   （`app.js` 的 `completeBlock()` 和 `rebuild()`），读取处用 `x.date ?? dateOf(x.day)` 兜底老数据。

## 没做完的事（按优先级）

1. **跨周滚动。** ~~`startDate` 固定在首次启动那天，下一周不会自动往后走。~~
   已修：`web/roll.js` 的 `rollStart(store, today)` 在每次 `rebuild()` 开头把 `startDate` 前移到今天，
   并把 `log` / `pending` / `lastPlan` 里的相对 `day` 先补出绝对 `date` 再按新起点重算（`pending` 的
   `key` 里含 `day`，一起改，否则打勾后删不掉那条待处理）。
   触发点就是 `rebuild()`（启动、从后台切回、5 分钟重排），别再另加定时器；函数本身幂等。
   测试见 `tests/roll.test.js`，其中一条专门验「第 10 天仍排得出块且不撞固定占用」。
   遗留提醒：`day` 现在可以是负数，显示日期一律从 `date` 推（见「坑」第 7 条）。
2. **提醒只有两条**：开始前 5 分钟、开始时。缺「到点没打勾就催一次」，也缺「每天一个晨间汇总」。
3. **导出 / 导入**：~~导出 JSON 在 WebView 里可能不工作~~ 已修。
   导出走原生 `exportFile()`：API 29+ 用 MediaStore 写进系统「下载」（不需要存储权限），
   拿 `content://` URI 顺手弹系统分享面板；API 26–28 退回 app 外部目录。
   导入走 `pickFile()`（系统文件选择器）→ `onActivityResult` 读文本 → `window.__TA_IMPORT` 回调页面 →
   校验 `tasks` / `template` → 二次确认 → 覆盖（旧数据自动进 `.bak`）。
4. **统计缺趋势**：没有 12 周格子图，也没有周对比。
5. **预估校准**：设计过「记住上次设置」的历史复用，代码里只做了表单里的「从最近用过」快捷填充，没有真正的中位数统计。
6. **崩溃上报**：本地这一侧已经齐了——JS 错误 / promise rejection 进诊断日志（`diag()`，环形 80 条、2 秒合并落盘），
   原生未捕获异常进 `crash.log`，设置 → 诊断 → **复制报告**（走 `Cosmos.copy()`，WebView 里 Clipboard API 不可用）。
   报告带版本、时区、屏幕、起点、数据规模。仓库里有 issue 模板要求贴这份报告。
   **自动上报故意没做**：那要加 `INTERNET` 权限和后端，而 release 包现在连网络权限都没有，这是产品的隐私卖点。

## 真机测试（Redmi 13C 5G / HyperOS 15）

手机已经配成专用测试机，下面的流程是验证过的。

**手机侧一次性设置**（插一张 SIM 卡之后才能全开）：
`开发者选项` → `USB 调试` ✅、`USB 安装` ✅、`USB 调试（安全设置）` ✅。
三个都开了才有：`adb install` 自动装包、`adb shell input` 模拟点击、`pm clear` 清数据。

**调试壳 APK**：`TA_DEV=1 node pack.js` 打出来的包会多两样东西——`INTERNET` 权限和
`usesCleartextTraffic`，配合 `MainActivity` 里的 `DEV=true` 从
`http://127.0.0.1:8090/web/index.html` 加载界面（走 `adb reverse tcp:8090 tcp:8090`），
连不上自动回落 assets。同时开 `WebView.setWebContentsDebuggingEnabled(true)`。
**效果：改 JS/CSS/引擎只需重启 App，不用重新打包安装。** 正式包不受影响（默认都不开）。

**常用命令**（这些脚本放在仓库外的工具目录里，不进仓库）：

```
ta.ps1 start            冷启动 + 挂上 CDP
ta.ps1 reload           重载界面（改完代码用这个）
ta.ps1 shot out.png     截图
ta.ps1 tab week         原生点一下某个标签页
ta.ps1 eval "<js>"      在 App 的 WebView 里执行 JS（可以调 window.Cosmos）
e2e.ps1                 整套回归：清数据 → 灌 10 天前存档 → 重载 → 7 项断言 → 截图
```

`cdp.mjs` 是零依赖 CDP 客户端，靠 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`。
`@文件` 语法可以传很长的 JS（比如整份存档）。

**踩过的坑**：

- `adb reverse` 是通的。别用 `nc` 单发请求判断——toybox 的 `nc` 读到 stdin EOF 就退出，
  会看到"连上了但 0 字节"。要 `(cat req; sleep 2) | nc ...`。
- **`android:debuggable` 会被这个 ROM 剥掉**：清单里确实写了（属性 id `0x0101000f`，bool true），
  装完系统仍报 `package not debuggable`，`run-as` 用不了。所以要读写 app 私有目录，
  走 CDP 调 `window.Cosmos.load()/save()`，别指望 `run-as`。
- `pm grant ... POST_NOTIFICATIONS` 不生效（granted 仍是 false），要用
  `appops set ai.cosmos.timeassistant POST_NOTIFICATION allow`。
- `getExternalFilesDir`/`/sdcard/Download` 里的 APK 不能直接 `pm install`（fuse 上下文读不了），
  但开了 USB 安装后 `adb install` 本身是通的。
- 本机没有 JDK：用任意 JDK 17+（比如 IDE 自带的 JBR）当 `javac`/`java`/`keytool`，
  再加 `android.jar`(platform-34) + `r8.jar` + `apksig.jar`（apksig 没有 CLI，`Sign.java` 直接调 API）。

## 怎么工作

- 注释和文案都是中文，代码尽量短
- 改完必须 `node --check` + `node --test`
- 改界面在浏览器里看（`node serve.js`），不要在 APK 里反复装
- 快照变了先确认是不是有意的，再 `UPDATE_SNAPSHOT=1`
- 加功能前先问：这会引入依赖吗？会的话先想想有没有不引入的做法

## 一件小事

`docs/` 目前只有这份交接说明和截图。开发过程中写过几份设计文档（需求确认单、优先级算法、预估处理、界面规范），
没随仓库走，有些也已经和实现不一致——**以代码为准**。
