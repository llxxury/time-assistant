# 视频生成流程（从零到成片）

本文是**可执行的 SOP**，不是大纲。按顺序做，每步都有命令和验收标准。

- 我（AI）能做：录屏、驱动 App、切片、拼装、烧字幕、做标题卡、导出编码
- 只能你做：**配音**（曼波 AI 声音）、B 站上传、最终审美取舍

---

## 0. 前置：装工具（10 分钟）

### 0.1 装 ffmpeg（必须，且要带 libass）

优先用 gyan.dev 的 essentials 包（含 libass，能烧字幕）：

```powershell
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
Invoke-WebRequest $url -OutFile D:\ta-build\ffmpeg.zip -UseBasicParsing
Expand-Archive D:\ta-build\ffmpeg.zip -DestinationPath D:\ta-build\ff -Force
$ff = (Get-ChildItem D:\ta-build\ff -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName
$env:Path = (Split-Path $ff) + ';' + $env:Path
& $ff -version
& $ff -filters 2>&1 | Select-String 'subtitles|drawtext'   # 两个都要有
```

验收：`-filters` 里能看到 `subtitles`（libass）和 `drawtext`。

**兜底（download 失败时）**：`pip install imageio-ffmpeg`，用它的 exe。
但它的静态构建**不一定带 libass**，那就走本文 4.2 的「PNG 字幕叠加」方案。

### 0.2 确认设备

```powershell
$adb = "$env:TEMP\platform-tools\adb.exe"
& $adb shell wm size          # 记录分辨率，后面所有录制参数跟它一致
& $adb shell wm density
& $adb shell which screenrecord
```

本文假设 `720x1600`（当前测试机）。**换机器就把下文所有 `1080` 改成实际宽、`1920` 改成实际高。**

---

## 1. 准备「演示数据」（15 分钟，关键）

真实录屏最丑的一点是数据脏：任务叫「1」「2」「3」、上周有测试残留、`较上周 -85%` 这种。

所以**先造一份好看的演示存档**，录完再恢复你自己的数据。

### 1.1 造存档

在 `D:\ta-build\demo-store.json` 写一份：

```json
{
  "startDate": "<今天>",
  "tasks": [
    { "id": "d1", "title": "第三章习题", "course": "线性代数", "stars": 4, "estMin": 180, "doneMin": 60,
      "deadlineDay": 2, "deadlineAt": 1380,
      "split": { "mode": "free", "minChunkMin": 45, "maxChunks": 4, "maxChunksPerDay": 2 } },
    { "id": "d2", "title": "英语精读笔记", "course": "大学英语", "stars": 2, "estMin": 90, "doneMin": 0,
      "deadlineDay": 5, "deadlineAt": 1140,
      "split": { "mode": "free", "minChunkMin": 30, "maxChunks": 3, "maxChunksPerDay": 1 } },
    { "id": "d3", "title": "期末项目", "course": "数据结构", "stars": 5, "estMin": 300, "doneMin": 0,
      "deadlineDay": 9, "deadlineAt": 1380,
      "split": { "mode": "free", "minChunkMin": 60, "maxChunks": 5, "maxChunksPerDay": 2 } }
  ],
  "fixed": [
    { "label": "体育", "weekday": 1, "start": 480, "end": 590, "kind": "weekly" },
    { "label": "高等数学A", "weekday": 2, "start": 600, "end": 710, "kind": "weekly" },
    { "label": "线性代数", "weekday": 3, "start": 480, "end": 590, "kind": "weekly" }
  ],
  "template": { "1": [[480,720],[780,1080],[1140,1320]], "2": [[480,720],[780,1080],[1140,1320]],
                "3": [[480,720],[780,1080],[1140,1320]], "4": [[480,720],[780,1080],[1140,1320]],
                "5": [[480,720],[780,1080],[1140,1320]], "6": [[540,720],[840,1140],[1260,1380]],
                "7": [[540,720],[840,1140],[1260,1380]] },
  "semester": { "enabled": true, "startDate": "<本学期第一周周一>", "totalWeeks": 17, "label": "大二上" },
  "log": [], "pending": [], "pins": [], "lastPlan": [],
  "theme": "indigo", "uiMode": "plain"
}
```

注意：
- `startDate` 用**今天**（跨周滚动会把起点滚到今天，先写好省得画面里日期错位）
- **不要放 `log` 历史**，否则仪表盘会出现 `较上周 -85%` 这种尴尬数字
- 任务名用**真实的学生任务**，不要用「测试」「1」

### 1.2 写进手机

```powershell
node tools/store-io.mjs restore D:\ta-build\demo-store.json
& $adb shell am force-stop ai.cosmos.timeassistant
& $adb shell am start -n ai.cosmos.timeassistant/.MainActivity
```

**录之前先备份你自己的数据**：`node tools/store-io.mjs dump D:\ta-build\my-store.json`，录完再 restore 回来。

### 1.3 验收

- 现在页仪表盘：「今日完成 0/3 项」，没有上周对比（`上周同期 无记录`）
- 计划页：有课，有块，没有「已过期」

---

## 2. 分镜表（把脚本翻译成操作）

以 `b站宣传脚本-v4.md`（痛点优先）为骨架。每个镜头 = 一次录屏 = 一个文件。

| # | 时长 | 画面 | 谁在操作 | 对应字幕 |
|---|---|---|---|---|
| T1 | 3s | 手机桌面 → 点图标进 App | 你（手动） | 1–2 |
| T2 | 4s | 现在页：大数字「还剩 2h 40m」 | 无人（静止） | 3–5 |
| T3 | 6s | 任务页 → 新建「第三章习题」→ 保存 | 脚本 | 6–9 |
| T4 | 5s | 计划页：列表 → 切时间轴 | 脚本 | 10–12 |
| T5 | 7s | 点块 → 改 13:30 → 保存 → 其余重排 | 脚本 | 13–16 |
| T6 | 8s | 现在页：开始 → 完成 → 休息卡 → 提前做下一段 | 脚本 | 17–21 |
| T7 | 5s | 回首页看仪表盘 | 脚本 | 22–24 |
| T8 | 6s | 设置 → 玻璃 → 深色 → 考卷 | 脚本 | 25–28 |
| T9 | 4s | 计划页 → 分享图片 → 相册里那张长图 | 脚本 | 29–31 |
| T10 | 5s | 结尾：画面停在标志性页面 | 无人 | 32–34 |

**总长约 53 秒**。竖屏、720×1600 录制，成片放大到 1080×2400。

---

## 3. 录制（每段 1–2 分钟）

### 3.1 单段录制

```powershell
$adb = "$env:TEMP\platform-tools\adb.exe"
$out = 'D:\ta-build\vid\raw'
New-Item -ItemType Directory -Force $out | Out-Null

# 录（screenrecord 单次上限 180 秒，够用）
& $adb shell screenrecord --bit-rate 16M --size 720x1600 /sdcard/take.mp4 &
# ↑ PowerShell 里用 Start-Job 更稳：
$job = Start-Job { & "$env:TEMP\platform-tools\adb.exe" shell screenrecord --bit-rate 16M --size 720x1600 /sdcard/take.mp4 }
Start-Sleep -Seconds 1
# —— 这里跑操作脚本（见 3.2）——
Stop-Job $job; Remove-Job $job
& $adb shell pkill -INT screenrecord      # 让 mp4 正常收尾
Start-Sleep -Milliseconds 800
& $adb pull /sdcard/take.mp4 "$out\T5.mp4"
& $adb shell rm /sdcard/take.mp4
```

**注意**：`screenrecord` 必须被 `SIGINT` 结束才能出完整 mp4；直接 kill 会得到损坏文件。所以流程是：`pkill -INT` → 等 1 秒 → pull。

### 3.2 操作脚本（可重复、可重录）

不要手点。用 adb 坐标 + CDP 双管齐下：

```powershell
# 坐标点击（坐标 = 截图上的像素 / 1，设备 720x1600）
& $adb shell input tap 360 96          # tab 栏
& $adb shell input swipe 620 900 120 900 200   # 左滑切页

# 确定性操作走 CDP（不怕坐标漂移）
node tools/cdp.mjs "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  [...document.querySelectorAll('.seg-btn')].find(b=>b.dataset.tab==='week').click();
  await s(500);
  document.querySelectorAll('.axis-bar')[0].click();
  await s(500);
  const st=document.querySelector('#pb-start'); st.value='13:30';
  document.querySelector('.sheet-save').click();
  await s(600); return 'ok';})()"
```

坐标怎么拿：截图 → 量像素。`adb shell screencap -p /sdcard/s.png` → pull → 看图量。当前设备的锚点：

```
tab 栏 y≈96；现在/计划/任务/统计/设置 x≈90/230/350/470/560
```

### 3.3 每段录完立刻验收

```powershell
# 时长 & 分辨率
ffprobe -v error -show_entries format=duration -show_entries stream=width,height -of default=noprint_wrappers=1 "$out\T5.mp4"
```

检查：
- 时长够（宁可多录 2 秒，剪辑时掐掉）
- 没有通知弹窗、没有输入法挡住界面
- 首帧不是黑屏（开始录屏后等 1 秒再操作）
- 鼠标光标不出现（adb 操作天然没有）

**不合格就重录**，别指望后期救。

### 3.4 录屏限制与对策

| 限制 | 对策 |
|---|---|
| 单次 180 秒 | 一段不超过 20 秒，天生够 |
| 不能录声音 | 声音后期配，本来就要 AI 配音 |
| 高帧率动作会糊 | 操作之间留 400–600ms 停顿 |
| 状态栏有时间和电量 | 后期裁掉顶部 40px，或用 `--size` 录大一点再裁 |

---

## 4. 字幕

现有 `D:\ta-build\shots\v4.srt`（58 条）。但**分镜和字幕要重新对齐**：录完才知道每段的真实长度。

### 4.1 重算时间轴

写一个 `D:\ta-build\vid\retime.mjs`：

```js
// 读 srt + 每段实际时长 → 输出新的 srt（把字幕按镜头重新分配绝对时间）
import fs from 'node:fs';

const takes = [
  { id: 'T1', file: 'T1.mp4', lines: [1, 2] },
  { id: 'T2', file: 'T2.mp4', lines: [3, 4, 5] },
  // ...
];
// 1) 用 ffprobe 拿每段时长（这里可以硬编码，省事）
// 2) 按 lines 里的字数比例切分该段时长
// 3) 输出 cum 时间轴
```

或者更省事：**按成片时间轴直接手写一份 SRT**，因为总长才 53 秒，34 条字幕，人工排比脚本快。

### 4.2 样式（烧进画面）

```powershell
$ff = 'D:\ta-build\ff\ffmpeg-*\bin\ffmpeg.exe'
& $ff -i D:\ta-build\vid\final.mp4 `
  -vf "subtitles=D:\ta-build\vid\final.srt:force_style='FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1.2,Shadow=0,MarginV=42,Alignment=2'" `
  -c:a copy -c:v libx264 -crf 18 -preset slow D:\ta-build\vid\final-sub.mp4
```

参数说明：
- `FontSize=18` 是**相对 720p 画布**的值，放大到 1080 宽后视觉上约 27px，竖屏够看
- `MarginV=42` 让字幕离底部足够远，避开手势条
- `PrimaryColour=&H00FFFFFF` 白字，`OutlineColour=&H90000000` 半透明黑描边

**如果 libass 不可用**（`subtitles` 滤镜报错）：改用 PNG 叠加——

```powershell
# 每条字幕渲染成一张透明 PNG（Pillow，支持中文）
python D:\ta-build\vid\make-subs.py     # 输出 sub-001.png ... sub-034.png
# 再用 overlay + enable 控制显隐
& $ff -i final.mp4 -i sub-001.png -filter_complex "[0][1]overlay=(W-w)/2:H-h-60:enable='between(t,0.5,3.2)'" out.mp4
```

### 4.3 标题卡与封面（Pillow 渲染）

```python
# D:\ta-build\vid\cover.py
from PIL import Image, ImageDraw, ImageFont
W, H = 1080, 1920
img = Image.new('RGB', (W, H), '#0C0E12')
d = ImageDraw.Draw(img)
f1 = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 96)
f2 = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 44)
d.text((80, 700), '我把这周排给你看', font=f1, fill='#F2F4F7')
d.text((80, 850), '一个 170 KB 的离线待办', font=f2, fill='#818A95')
img.save(r'D:\ta-build\vid\cover.png')
```

封面单独出图，**不要从视频里截**（截出来的字小、糊、构图差）。

---

## 5. 配音（你来做，30 分钟）

1. 把分镜对应的文字稿整理成**一段连续文本**（带段落停顿）
2. 用曼波 AI 声音生成 wav/mp3
3. **按段落切成 10 来个小文件**（T1.wav … T10.wav），比一整条好对齐
4. 每条音频必须 **≤ 对应镜头时长**；超了就精简文字，不要加速（加速会显得赶）

**备用**：如果配音比画面短，把镜头拉长（`tpad` 复制末帧），不要压缩画面。

---

## 6. 拼装（ffmpeg，40 分钟）

### 6.1 统一规格

所有镜头先统一成同一规格再拼，否则拼接会花屏：

```powershell
New-Item -ItemType Directory -Force D:\ta-build\vid\norm | Out-Null
foreach ($f in Get-ChildItem D:\ta-build\vid\raw\*.mp4) {
  & $ff -i $f.FullName -vf "scale=1080:2400:flags=lanczos,fps=60,setsar=1" `
    -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p `
    "D:\ta-build\vid\norm\$($f.BaseName).mp4"
}
```

### 6.2 拼接

```powershell
# 生成清单
Get-ChildItem D:\ta-build\vid\norm\T*.mp4 | Sort-Object Name |
  ForEach-Object { "file '$($_.FullName -replace '\\','/')'" } |
  Set-Content D:\ta-build\vid\list.txt -Encoding ASCII
# 拼接
& $ff -f concat -safe 0 -i D:\ta-build\vid\list.txt -c copy D:\ta-build\vid\final.mp4
```

`-c copy` 要求所有片段编码参数完全一致——所以 6.1 的统一规格不能省。

### 6.3 变速（可选）

某段想快一点（比如切主题那 6 秒）：

```powershell
& $ff -i T8.mp4 -filter_complex "[0:v]setpts=0.6*PTS[v]" -map "[v]" T8-fast.mp4
```

注意：**画面加速后，这段的配音也要单独处理**，否则口型/节奏对不上。所以只在**无人声段**用变速（比如纯操作演示）。

### 6.4 混音

```powershell
# 配音拼成一条
& $ff -f concat -safe 0 -i audio-list.txt -c copy voice.wav
# 合到画面
& $ff -i final-sub.mp4 -i voice.wav -c:v copy -c:a aac -b:a 192k -shortest final-audio.mp4
```

如果人声偏小：`-af "loudnorm=I=-16:TP=-1.5:LRA=11"`。
如果想加背景音乐：`-filter_complex "[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first"`。

### 6.5 终稿参数

```powershell
& $ff -i final-audio.mp4 -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p `
  -c:a aac -b:a 192k -movflags +faststart `
  -metadata title="我把这周排给你看" D:\ta-build\vid\export-1080p60.mp4
```

`+faststart` 让 moov 前移，B 站上传后秒开。

---

## 7. 验收（15 分钟）

| 检查 | 方法 |
|---|---|
| 总时长 | `ffprobe`，和分镜表一致（±2s） |
| 音画同步 | 抽 3 个点看：开头、中段、结尾 |
| 字幕不错位 | 全片 1.5 倍速过一遍 |
| 无黑帧 | `ffmpeg -vf blackdetect=d=0.1` 扫一遍 |
| 无手机通知 | 肉眼（录屏时就该避免） |
| 码率/体积 | 45 MB 以内（B 站 1080p 舒适区） |

```powershell
& $ff -i export-1080p60.mp4 -vf blackdetect=d=0.1:pix_th=0.1 -f null - 2>&1 | Select-String 'black'
```

---

## 8. 交付清单

```
D:\ta-build\vid\
├─ raw/            T1.mp4 … T10.mp4      原始录屏
├─ norm/           统一规格后的片段
├─ final.srt       成片字幕
├─ cover.png       封面（1080×1920）
├─ export-1080p60.mp4   成片
└─ takes.md        每段的操作脚本（可复现）
```

---

## 9. 常见坑

| 坑 | 后果 | 预防 |
|---|---|---|
| `screenrecord` 被 kill 而不是 SIGINT | mp4 损坏，打不开 | 用 `pkill -INT`，等 1 秒 |
| 片段规格不统一就 concat | 花屏、音画不同步 | 先 6.1 统一规格 |
| 字幕字号按 1080p 设 | 竖屏上大得离谱 | 按 720 宽设，再放大 |
| 演示数据有测试残留 | 画面里出现「较上周 -85%」「测试1」 | 第 1 步造干净存档 |
| 录屏时通知弹出 | 整段作废 | 开勿扰；或录完检查，重录 |
| 配音比画面长 | 结尾被截断 | 配音短于画面；不够就让画面停住 |

---

## 10. 时间预算

| 阶段 | 时间 |
|---|---|
| 装工具 + 造演示数据 | 30 min |
| 录 10 段（含重录 2–3 段） | 60 min |
| 字幕对齐 + 样式调试 | 40 min |
| 配音（你） | 30 min |
| 拼装 + 混音 | 40 min |
| 验收 + 导出 | 20 min |
| **合计** | **约 3.5 小时**（不含选题和文案，那些已经有了） |

---

## 附：一句话版本

> 装 ffmpeg → 造干净演示数据 → 按分镜录 10 段 → 统一规格 → 拼 → 烧字幕 → 盖配音 → 导出 1080p60。

真正的难点只有两个：**演示数据要干净**，**每段录完立刻验收**。其余都是命令。
