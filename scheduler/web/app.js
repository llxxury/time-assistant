// 界面层：直接复用 engine/ 的同一份代码。浏览器里跑，打包进 APK 也跑同一份。

import { makeState, plan, freeOf, fixedBlocksOn } from '../engine/plan.js';
import { fmtClock, fmtDur, total } from '../engine/time.js';
import { rollStart } from './roll.js';
import { VERSION, VERSION_CODE } from '../version.js';
import seed from '../data/seed.js';

const DAY_MS = 86400000;
const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const KEY = 'cosmos.scheduler.v2';

function todayStr() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

/* ================= 数据 ================= */

const bridge = typeof window !== 'undefined' ? window.Cosmos : null;

// 读存档分三态：empty（首次启动）/ ok / corrupt。
// 关键：corrupt 时**绝不覆盖**。老版本会把它当成首次启动灌种子数据，
// 用户就这么在无提示的情况下丢过一次全部数据。
function readStore() {
  let raw = '';
  try {
    raw = (bridge && bridge.load ? bridge.load() : localStorage.getItem(KEY)) || '';
  } catch (e) {
    return { state: 'error', raw: '', error: String(e) };
  }
  if (!raw) return { state: 'empty', raw: '' };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { state: 'corrupt', raw };
    return { state: 'ok', data, raw };
  } catch (e) {
    return { state: 'corrupt', raw };
  }
}

let storageLocked = false; // 存档损坏时锁住写入，保住现场
let recoverInfo = null; // { raw } 供恢复面板导出
let recoveredFromBackup = false;

const first = readStore();
let store = first.state === 'ok' ? first.data : null;

if (!store && (first.state === 'corrupt' || first.state === 'error')) {
  // 先试 .bak（上一次成功保存的副本）
  let bak = null;
  try {
    const rawBak = bridge && bridge.loadBackup ? bridge.loadBackup() : '';
    if (rawBak) bak = JSON.parse(rawBak);
  } catch (e) {
    bak = null;
  }
  if (bak && typeof bak === 'object') {
    store = bak;
    recoveredFromBackup = true;
    // 丢掉坏掉的主存档，免得接下来第一次 save() 把它复制进 .bak
    try {
      if (bridge && bridge.discardPrimary) bridge.discardPrimary();
    } catch (e) {}
  } else {
    recoverInfo = { raw: first.raw || '' };
    storageLocked = true; // 等用户决定，期间一个字都不写
  }
}

if (!store) {
  // 内存里先给一份能渲染的数据；storageLocked 时不会落盘
  const fx = seed;
  const today = todayStr();
  // 滚动起点 = 今天。示例任务的截止按「今天 + 原来的天数偏移」铺开，
  // 保证第一次打开看到的都是将来的事，而不是一堆已经过期的。
  store = {
    ...fx,
    startDate: today,
    tasks: fx.tasks.map((t) => ({ ...t, deadlineDate: addDays(today, t.deadlineDay ?? 0) })),
  };
}

function writeStore() {
  if (storageLocked) return; // 恢复模式：宁可不保存，也不覆盖现场
  try {
    const json = JSON.stringify(store);
    if (bridge && bridge.save) bridge.save(json);
    else localStorage.setItem(KEY, json);
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

// 首次启动：把种子数据落盘
if (first.state === 'empty') writeStore();

/* ================= 派生 ================= */

/**
 * 排程跨度：跟着最远的截止日走，最多 120 天。
 * 以前写死 7 天，20 天后交的任务只能靠压力评分体现，永远排不进来。
 */
function computeSpan() {
  let maxD = 6; // 至少 7 天
  for (const t of store.tasks) {
    const d = t.deadlineDate ? dateToDay(t.deadlineDate) : t.deadlineDay;
    if (Number.isFinite(d) && d > maxD) maxD = d;
  }
  return Math.min(120, maxD + 1);
}
const spanDays = () => store.spanDays || store.horizonDays || 7;

const baseWd = () => new Date(Date.parse(store.startDate + 'T00:00:00Z')).getUTCDay() || 7;
const wdOf = (d) => ((baseWd() - 1 + d) % 7) + 1;
const dateOf = (d) =>
  new Date(Date.parse(store.startDate + 'T00:00:00Z') + d * DAY_MS).toISOString().slice(0, 10);
const dateToDay = (s) =>
  Math.round((Date.parse(s + 'T00:00:00Z') - Date.parse(store.startDate + 'T00:00:00Z')) / DAY_MS);
// 绝对日期 → 星期几。跨周滚动后 day 可以是负数，星期一律从 date 推，别再对 day 取模。
const wdOfDate = (s) => new Date(s + 'T00:00:00Z').getUTCDay() || 7;
const mmdd = (d) => dateOf(d).slice(5);

let schedule;
let baseFree = [];

function nowOffset() {
  return Math.round(
    (Date.parse(todayStr() + 'T00:00:00Z') - Date.parse(store.startDate + 'T00:00:00Z')) / DAY_MS
  );
}

function rebuild() {
  // 起点必须跟着今天走：钉在首次启动那天的话，第 8 天起整个 7 天窗口都落在过去，
  // 一块也排不出、通知也不响，还谎报「找不到合规空档」。
  rollStart(store, todayStr());
  const off = nowOffset();
  const nm = new Date().getHours() * 60 + new Date().getMinutes();

  // 上一版计划里「时间已过、又没处理」的块 → 待处理，等用户决定怎么办
  store.pending = store.pending || [];
  for (const b of store.lastPlan ?? []) {
    const past = b.day < off || (b.day === off && b.end <= nm);
    if (!past) continue;
    const key = `${b.taskId}|${b.day}|${b.start}`;
    if (store.pending.some((p) => p.key === key)) continue;
    const t = store.tasks.find((x) => x.id === b.taskId);
    if (!t || (t.doneMin || 0) >= t.estMin) continue;
    store.pending.push({ ...b, date: dateOf(b.day), key });
  }

  const resting = Boolean(store.restUntil && Date.now() < store.restUntil);
  store.spanDays = computeSpan();
  schedule = makeState(store, { nowDay: off, nowMinute: nm, spanDays: store.spanDays });

  if (resting && Array.isArray(store.lastPlan) && store.lastPlan.length) {
    // 休息中：冻结计划，不重排。用户刚做完一段，多出来的时间是奖励，不该被立刻填满。
    schedule.placed = store.lastPlan.map((p) => ({ ...p }));
  } else {
    if (resting) store.restUntil = 0; // 计划已经空了，休息自然结束
    plan(schedule);
    store.lastPlan = schedule.placed.map((p) => ({
      taskId: p.taskId,
      day: p.day,
      start: p.start,
      end: p.end,
    }));
  }

  baseFree = [];
  for (let d = 0; d < spanDays(); d++) baseFree.push(total(freeOf(schedule, d)));
  writeStore();
  pushReminders();
}

/* ================= 提醒 ================= */

function pushReminders() {
  if (!bridge || !bridge.setReminders) return;
  try {
    const out = [];
    const now = Date.now();
    for (const p of schedule.placed) {
      const t = schedule.tasks.find((x) => x.id === p.taskId);
      if (!t) continue;
      const dayStart = new Date(dateOf(p.day) + 'T00:00:00').getTime();
      const startMs = dayStart + p.start * 60000;
      if (startMs > now + 36 * 3600 * 1000) continue;
      const base = p.taskId + '-' + p.day + '-' + p.start;
      if (startMs - 5 * 60000 > now) {
        out.push({
          id: base + '-pre',
          title: '5 分钟后：' + t.title,
          text: fmtClock(p.start) + '–' + fmtClock(p.end),
          at: startMs - 5 * 60000,
        });
      }
      if (startMs > now) {
        out.push({
          id: base + '-at',
          title: '现在：' + t.title,
          text: fmtClock(p.start) + '–' + fmtClock(p.end),
          at: startMs,
        });
      }
    }
    bridge.setReminders(JSON.stringify(out));
  } catch (e) {}
}

/* ================= 打勾 ================= */

function completeBlock(b) {
  const t = store.tasks.find((x) => x.id === b.taskId);
  if (!t) return;
  const minutes = b.end - b.start;
  t.doneMin = Math.min(t.estMin, (t.doneMin || 0) + minutes);
  store.log = store.log || [];
  // 实际用时 = 打勾时刻 − 这一段计划开始时刻（不点开始，系统自己算）
  const nm = new Date().getHours() * 60 + new Date().getMinutes();
  const actualMin = b.day === nowOffset() ? Math.max(1, Math.min(nm - b.start, minutes)) : minutes;
  store.log.push({
    taskId: b.taskId,
    day: b.day,
    date: dateOf(b.day),
    start: b.start,
    end: b.end,
    minutes,
    actualMin,
    at: Date.now(),
    kind: 'done',
  });
  store.pending = (store.pending || []).filter((x) => x.key !== `${b.taskId}|${b.day}|${b.start}`);
  removePin(b); // 打勾了，这块不再是「计划」，pin 要清掉，否则会重复扣时长

  // 完成之后冻结计划：多出来的时间是奖励，由用户决定休息还是提前做下一段。
  // 规则沿用引擎的块间休息：clamp(块长/6, 5, 20) 分钟。
  const rest = Math.max(5, Math.min(20, Math.round(minutes / 6)));
  store.lastPlan = (store.lastPlan || []).filter(
    (p) => !(p.taskId === b.taskId && p.day === b.day && p.start === b.start)
  );
  store.restUntil = Date.now() + rest * 60000;
  store.restMin = rest;

  rebuild();
  paint();
  flashStamp();
  toast(`完成 ${fmtDur(minutes)}，休息 ${rest} 分钟`);
}

async function handlePending(p, action) {
  const i = store.pending.findIndex((x) => x.key === p.key);
  const t = store.tasks.find((x) => x.id === p.taskId);

  if (action === 'done') {
    if (t) {
      t.doneMin = Math.min(t.estMin, (t.doneMin || 0) + (p.end - p.start));
      store.log = store.log || [];
      store.log.push({ ...p, minutes: p.end - p.start, at: Date.now(), kind: 'done' });
    }
    if (i >= 0) store.pending.splice(i, 1);
    toast('已记为完成');
  } else if (action === 'later') {
    if (i >= 0) store.pending.splice(i, 1);
    toast('已顺延，重新排');
  } else if (action === 'edit') {
    const left = prompt(
      '还剩多少分钟？（其余算作已完成）',
      String(Math.max(5, (t?.estMin ?? 60) - (t?.doneMin ?? 0)))
    );
    if (left == null) return;
    const n = Number(left);
    if (!Number.isFinite(n) || n < 0) return toast('数字不对');
    if (t) t.doneMin = Math.max(0, t.estMin - n);
    if (i >= 0) store.pending.splice(i, 1);
    toast(`按剩余 ${fmtDur(n)} 重排`);
  } else if (action === 'del') {
    if (!(await askConfirm({ title: '删除任务', text: `「${t?.title ?? ''}」会被删掉，计划会重新排。`, ok: '删除', danger: true }))) return;
    store.tasks = store.tasks.filter((x) => x.id !== p.taskId);
    store.pending = store.pending.filter((x) => x.taskId !== p.taskId);
    dropPinsOfTask(p.taskId);
    toast('已删除');
  }

  rebuild();
  paint();
}

function renderPending() {
  const frag = document.createDocumentFragment();
  const list = store.pending || [];
  if (!list.length) return frag;

  frag.append(el(`<div class="section-title">待处理 · ${list.length} 段没打勾</div>`));
  for (const p of list) {
    const t = store.tasks.find((x) => x.id === p.taskId);
    const meta = `${WD[wdOfDate(p.date ?? dateOf(p.day))]} ${fmtClock(p.start)}–${fmtClock(p.end)} · ${fmtDur(
      p.end - p.start
    )}`;
    const exam = uiMode() === SKIN_EXAM;
    const card = el(`
      <div class="pending">
        <div class="pending-title">${t?.title ?? '（任务已删除）'}</div>
        <div class="pending-meta">${meta}</div>
        <div class="pending-actions">
          <button data-a="done">${exam ? '补上' : '完成了'}</button>
          <button data-a="later">${exam ? '延后' : '顺延'}</button>
          <button data-a="edit">${exam ? '改时长' : '改剩余'}</button>
          <button data-a="del">${exam ? '删掉' : '删除'}</button>
        </div>
        ${exam && p === list[0] ? sticker('note', 2, '这题空着') : ''}
      </div>`);
    card.querySelectorAll('button').forEach((b) => {
      b.onclick = () => handlePending(p, b.dataset.a);
    });
    frag.append(card);
  }
  return frag;
}

// 每次现取，页面开着不动也要跟着走
function nowDayIdx() {
  const d = new Date();
  return Math.floor(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.parse(store.startDate + 'T00:00:00Z')) /
      DAY_MS
  );
}
function nowMinute() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const view = {
  tab: 'now',
  preview: { live: nowDayIdx() >= 0 && nowDayIdx() < spanDays(), day: 0, minute: 19 * 60 },
};

const blocksOf = (d) =>
  schedule.placed
    .filter((p) => p.day === d)
    .map((p) => ({ ...p, task: schedule.tasks.find((t) => t.id === p.taskId) }))
    .sort((a, b) => a.start - b.start);

function clockOf() {
  if (view.preview.live) {
    const d = nowDayIdx();
    return d >= 0 && d < spanDays()
      ? { day: d, minute: nowMinute(), live: true }
      : { day: null, minute: nowMinute(), live: true };
  }
  return { ...view.preview, live: false };
}

/* ================= 小组件 ================= */

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const kids = [...t.content.children];
  if (kids.length === 1) return kids[0];
  // 多根模板兜个底：包一层 div，避免某些调用拿到 null
  const box = document.createElement('div');
  box.append(...t.content.childNodes);
  return box;
};

let toastTimer;
function toast(msg) {
  const box = document.getElementById('toast');
  box.textContent = msg;
  box.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-on'), 1900);
}

/**
 * 导出一段文本成文件。
 * 原生优先：写到系统「下载」（MediaStore），有 content:// 就顺手弹分享面板。
 * 浏览器里退回 a.download —— 注意在 WebView 里这条路是不通的，所以才需要原生桥。
 */
function exportText(name, mime, text) {
  if (bridge && bridge.exportFile) {
    const uri = bridge.exportFile(name, mime, text);
    if (!uri) {
      toast('导出失败：存储不可写');
      return '';
    }
    if (uri.startsWith('content://')) {
      toast('已保存到「下载」：' + name);
      if (bridge.shareUri) {
        try {
          bridge.shareUri(uri, mime, '导出备份');
        } catch (e) {}
      }
    } else {
      toast('已保存：' + uri);
    }
    return uri;
  }
  try {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    toast('已导出');
    return name;
  } catch (e) {
    toast('导出失败：' + e.message);
    return '';
  }
}


/**
 * 复制文本。三级回退：
 *   1) 原生桥（WebView 里最稳，appassets.local 不是安全上下文，Clipboard API 用不了）
 *   2) navigator.clipboard（浏览器 / localhost）
 *   3) execCommand（老办法，选中一个临时 textarea）
 */
async function copyText(text) {
  if (bridge && bridge.copy) {
    try {
      bridge.copy(text);
      return true;
    } catch (e) {}
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}


/* ================= 导入 ================= */

/** 判断像不像本 App 的存档 */
function looksLikeStore(o) {
  return !!o && typeof o === 'object' && Array.isArray(o.tasks) && !!o.template && typeof o.template === 'object';
}

/** 把一段 JSON 文本导入成当前存档。返回是否成功 */
async function importText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    toast('不是合法的 JSON');
    return false;
  }
  if (!looksLikeStore(data)) {
    toast('这不像是本 App 的存档（缺 tasks / template）');
    return false;
  }
  const n = data.tasks.length;
  const logN = (data.log || []).length;
  const start = data.startDate || '?';
  if (
    !(await askConfirm({
      title: '导入并覆盖',
      text: `任务 ${n} 件，完成记录 ${logN} 条，起点 ${start}\n\n当前数据会先存成一份 .bak。`,
      ok: '覆盖',
      danger: true,
    }))
  ) {
    return false;
  }
  store = data;
  storageLocked = false;
  recoverInfo = null;
  writeStore();
  rebuild();
  paint();
  toast('已导入');
  return true;
}

/** 原生选文件；回调由 MainActivity 触发 window.__TA_IMPORT */
function pickImportFile() {
  if (bridge && bridge.pickFile) {
    bridge.pickFile();
    return;
  }
  // 浏览器兜底
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => importText(String(r.result || ''));
    r.readAsText(f);
  };
  input.click();
}

// MainActivity 选完文件后会调这个
window.__TA_IMPORT = () => {
  const text = bridge && bridge.takeImport ? bridge.takeImport() : '';
  if (!text) {
    toast('没有读到文件');
    return;
  }
  importText(text);
};

/* ================= 诊断日志 ================= */

const DIAG_MAX = 80;
let diagTimer = null;

/**
 * 记录一条诊断日志。
 * 注意：这里**不能**每次都 writeStore —— 一个渲染循环里的错误会每 30 秒把整份存档重写一遍，
 * 而写盘本身又要序列化。改成 2 秒合并一次，页面隐藏时立刻落盘。
 */
function diag(level, msg) {
  try {
    const st = store;
    if (!st) return;
    st.diag = st.diag || [];
    st.diag.push({ t: Date.now(), level, msg: String(msg).slice(0, 500) });
    if (st.diag.length > DIAG_MAX) st.diag.splice(0, st.diag.length - DIAG_MAX);
    if (!diagTimer) diagTimer = setTimeout(flushDiag, 2000);
  } catch (e) {}
}

function flushDiag() {
  clearTimeout(diagTimer);
  diagTimer = null;
  try {
    writeStore();
  } catch (e) {}
}

// 页面被切走 / 关闭前把攒着的日志落盘，别丢现场
window.addEventListener('pagehide', flushDiag);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDiag();
});

// 手机上不好开控制台：出错既写日志，也在屏幕底部亮一句
window.addEventListener('error', (e) => {
  diag('error', (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = '脚本出错：' + (e.message || String(e.error));
  box.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-on'), 8000);
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  diag('reject', (r && (r.stack || r.message)) || String(r));
});

/* ================= 现在 ================= */

function renderNow() {
  const { day, minute, live } = clockOf();

  // 休息中：刚完成一段，计划被冻结。这段时间的处置权交给用户。
  const restLeft = store.restUntil ? Math.ceil((store.restUntil - Date.now()) / 60000) : 0;
  if (restLeft > 0) {
    const restList = blocksOf(day).filter((b) => b.end > minute);
    const upcoming = restList[0];
    const card = el(`
      <section class="now-card">
        <div class="now-label"><span class="dot"></span>休息中</div>
        <div class="now-task">还剩 ${restLeft} 分钟</div>
        <div class="now-sub">刚做完一段。这段时间归你，可以歇，也可以接着干。</div>
        <div class="now-actions">
          <button class="btn btn-primary" id="rest-done">结束休息</button>
          ${upcoming ? '<button class="btn btn-ghost" id="rest-next">提前做下一段</button>' : ''}
        </div>
      </section>`);
    card.querySelector('#rest-done').onclick = () => {
      store.restUntil = 0;
      rebuild();
      paint();
      toast('继续安排');
    };
    const nb = card.querySelector('#rest-next');
    if (nb) {
      nb.onclick = () => {
        store.restUntil = 0;
        const err = applyPlanEdit(upcoming, minute, upcoming.end - upcoming.start);
        toast(err || '提前开始');
      };
    }
    return card;
  }

  if (!store.tasks.length) {
    const card =
      uiMode() === SKIN_EXAM
        ? el(`<section class="now-card empty exam-paper">
        <div class="paper-kicker">${new Date().getFullYear()} 学年度 · 时间安排</div>
        <div class="paper-title">期 末 测 验</div>
        <div class="paper-rule"></div>
        <div class="paper-ask">本页暂无题目</div>
        <div class="paper-sub">去「任务」加一道，它就开始替你排。</div>
        <div class="paper-blank"><span>姓名</span><i></i><span>学号</span><i></i></div>
        ${sticker('note', 0, '这页是空白的')}
      </section>`)
        : el(`<section class="now-card empty">
        <div class="empty-mark">＋</div>
        <div class="now-task">还没有任务</div>
        <div class="now-sub">去「任务」页加一件，这里就开始替你安排。</div>
      </section>`);
    const go = el(`<button class="btn btn-primary" style="margin-top:20px">去添加</button>`);
    go.onclick = () => {
      view.tab = 'tasks';
      paint();
    };
    card.append(go);
    return card;
  }

  if (day == null || day < 0 || day >= spanDays()) {
    return el(`
      <section class="now-card">
        <div class="now-label"><span class="dot"></span>${live ? '实时' : '预览'}</div>
        <div class="empty-mark">✓</div>
        <div class="now-task">不在本周计划内</div>
        <div class="now-sub">当前时间没有对应的排班</div>
      </section>`);
  }

  const list = blocksOf(day);
  const cur = list.find((b) => b.start <= minute && minute < b.end);
  const next = list.find((b) => b.start > minute);

  if (!cur && !next) {
    const card = el(`
      <section class="now-card">
        <div class="now-label"><span class="dot"></span>${WD[wdOf(day)]} ${mmdd(day)} · ${live ? '实时' : '预览'}</div>
        <div class="empty-mark">✓</div>
        <div class="now-task">今天已经收工</div>
        <div class="now-sub">${list.length ? '当天的安排都过去了' : '这一天没有排任务'}</div>
      </section>`);
    // 没有任务、也没有安排时，给一个明确的入口，而不是只说一句「没有排任务」
    if (!list.length) {
      const go = el(`<button class="btn btn-primary" style="margin-top:14px">去添加任务</button>`);
      go.onclick = () => {
        view.tab = 'tasks';
        paint();
      };
      card.append(go);
    }
    return card;
  }

  const b = cur ?? next;
  const isCur = Boolean(cur);
  const remain = isCur ? b.end - minute : b.start - minute;
  const pct = isCur ? Math.round(((minute - b.start) / (b.end - b.start)) * 100) : 0;
  const todayPlanned = list.reduce((s, x) => s + (x.end - x.start), 0);

  const card = el(`
    <section class="now-card">
      <div class="now-label">
        <span class="dot ${isCur ? 'live' : ''}"></span>
        ${isCur ? '现在' : '下一段'} · ${WD[wdOf(day)]} ${mmdd(day)}${live ? '' : ' · 预览'}
      </div>
      <div class="now-task">${b.task.title}</div>
      <div class="now-when">${fmtClock(b.start)}–${fmtClock(b.end)} · ${fmtDur(b.end - b.start)}</div>
      <div class="now-time">${fmtDur(remain)}</div>
      <div class="now-sub">${isCur ? '还剩' : '距开始'}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="now-actions">
        <button class="btn btn-primary" id="do-done">${isCur ? '完成' : '开始'}</button>
        <button class="btn btn-ghost" id="do-later">延后 30 分钟</button>
      </div>
    </section>`);

  card.querySelector('#do-done').onclick = () => {
    if (isCur) completeBlock(b);
    else {
      // 立刻提前：把这一块钉到现在，计划里其它块会被绕开重排
      store.restUntil = 0;
      const err = applyPlanEdit(b, minute, b.end - b.start);
      toast(err || '已提前开始');
    }
  };
  card.querySelector('#do-later').onclick = () => {
    if (isCur) return toast('这一段正在进行，只能改时长');
    const err = applyPlanEdit(b, b.start + 30, b.end - b.start);
    toast(err || '已顺延 30 分钟，后面的重新排好了');
  };

  const follows = list.filter((x) => x.start >= b.end).slice(0, 2);
  const wrap = document.createDocumentFragment();
  wrap.append(card);
  if (follows.length) {
    wrap.append(el(`<div class="section-title">接着</div>`));
    for (const f of follows) {
      wrap.append(
        el(`
        <div class="row" style="padding-left:2px">
          <span class="row-time">${fmtClock(f.start)}</span>
          <span class="bar"></span>
          <span class="row-label">${f.task.title} · ${fmtDur(f.end - f.start)}</span>
        </div>`)
      );
    }
  }
  wrap.append(
    el(`
      <div class="section-title">这一天</div>
      <div class="card">
        <div class="muted" style="font-size:13.5px">可用 ${fmtDur(baseFree[day])}，已排 ${fmtDur(todayPlanned)}</div>
        <div class="progress"><i style="width:${Math.min(100, Math.round((todayPlanned / (baseFree[day] || 1)) * 100))}%"></i></div>
      </div>`)
  );
  return wrap;
}

/* ================= 周视图 ================= */

function renderWeek() {
  const frag = document.createDocumentFragment();

  if (!store.tasks.length) {
    frag.append(
      el(`<div class="card" style="text-align:center;padding:30px 18px;margin-bottom:12px">
            <div class="muted" style="font-size:13.5px">还没有任务。加一件之后，这里就会出现具体安排。</div>
          </div>`)
    );
  }

  const totalFree = baseFree.reduce((a, b) => a + b, 0);
  const ratio = schedule.rules.fillRatio ?? 1;
  const usable = Math.round(totalFree * ratio);
  frag.append(
    el(`<div class="card" style="margin-bottom:12px">
          <div class="muted" style="font-size:13.5px">
            未来 ${spanDays()} 天可用 <b style="color:var(--ink)">${fmtDur(totalFree)}</b> ·
            最多排 <b style="color:var(--ink)">${fmtDur(usable)}</b> ·
            留白 ${fmtDur(totalFree - usable)}（${Math.round((1 - ratio) * 100)}%）
          </div>
        </div>`)
  );

  const overdue = schedule.infeasible.filter((f) => f.overdue);
  const short = schedule.infeasible.filter((f) => !f.overdue);

  if (overdue.length) {
    frag.append(
      el(`<div class="banner">已过期：${overdue
        .map((f) => `${f.task.title}（差 ${fmtDur(f.remain)}）`)
        .join('、')}。要么顺延，要么删掉。</div>`)
    );
  }
  if (short.length) {
    const need = short.reduce((s, f) => s + f.remain, 0);
    frag.append(
      el(`<div class="banner">未来 7 天缺 ${fmtDur(need)}：${short
        .map((f) => f.task.title)
        .join('、')} 排不下。要么放开时间，要么砍掉一件。</div>`)
    );
  }

  let lastWeek = -1;
  for (let d = 0; d < spanDays(); d++) {
    const fixed = fixedBlocksOn(schedule, d);
    const tasks = blocksOf(d);
    // 第一周全部显示；之后只显示有内容的日子，避免跨度变长后出现几十张空卡片
    if (d >= 7 && !fixed.length && !tasks.length) continue;
    const week = Math.floor(d / 7);
    if (week !== lastWeek && d >= 7) {
      frag.append(el(`<div class="section-title">第 ${week + 1} 周</div>`));
    }
    lastWeek = week;
    const rows = [
      ...fixed.map((b) => ({ s: b.start, e: b.end, label: b.label, kind: 'fixed' })),
      ...tasks.map((b) => ({ s: b.start, e: b.end, label: b.task.title, kind: 'task', block: b })),
    ];
    rows.sort((a, b) => a.s - b.s || a.e - b.e);
    const isToday = view.preview.live && d === nowDayIdx();

    const card = el(`
      <section class="day ${isToday ? 'is-today' : ''}">
        <div class="day-head">
          <span class="day-name">${WD[wdOf(d)]}</span>
          <span class="day-date">${dateOf(d)}</span>
          <span class="day-free">可用 ${fmtDur(baseFree[d])}</span>
        </div>
        ${rows.length ? '' : '<div class="row-empty">空闲</div>'}
      </section>`);

    for (const r of rows) {
      const row = el(`
        <div class="row ${r.kind === 'task' ? 'is-task' : 'is-fixed'} ${r.block ? 'is-editable' : ''}">
          <span class="row-time">${fmtClock(r.s)}–${fmtClock(r.e)}</span>
          <span class="bar"></span>
          <span class="row-label">${r.label}${r.block?.pinned ? '<span class="pin">已锁定</span>' : ''}</span>
        </div>`);
      if (r.block) row.onclick = () => openBlockEditor(r.block);
      card.append(row);
    }
    card.append(el('<div style="height:8px"></div>'));
    frag.append(card);
  }
  return frag;
}

/* ================= 计划编辑（pin） ================= */
/*
 * 用户手动改过的块会被「钉住」：写进 store.pins，引擎重排时当成既定事实。
 * 没有 pin 的话，每 5 分钟一次的全量重排会把用户的修改冲掉。
 */

const pinsOf = () => (store.pins = store.pins || []);

const pinIndexOf = (block) =>
  pinsOf().findIndex((p) => p.taskId === block.taskId && p.day === block.day && p.start === block.start);

function removePin(block) {
  const i = pinIndexOf(block);
  if (i < 0) return false;
  pinsOf().splice(i, 1);
  return true;
}

function dropPinsOfTask(taskId) {
  if (!Array.isArray(store.pins) || !store.pins.length) return;
  store.pins = store.pins.filter((p) => p.taskId !== taskId);
}

/** 校验一次手动改动，返回错误文案；合法返回 null */
function checkPlanEdit(block, start, dur) {
  if (!Number.isFinite(start) || !Number.isFinite(dur)) return '时间填得不对';
  if (dur < 5) return '至少 5 分钟';
  const end = start + dur;
  if (start < 0 || end > 1440) return '超出了一天的范围';

  const day = block.day;
  const today = nowDayIdx();
  if (day < 0 || day >= spanDays()) return '超出了排程窗口';
  if (day < today) return '这一天已经过去了';
  if (day === today && start < nowMinute()) return '不能排到已经过去的时间';

  // 不许撞课（含前后缓冲）
  const buf = schedule.rules.classBufferMin || 0;
  for (const f of fixedBlocksOn(schedule, day)) {
    if (start < f.end + buf && f.start - buf < end) return `撞上了「${f.label}」`;
  }

  // 不许和别的块重叠（跳过它自己）
  for (const p of schedule.placed) {
    if (p.taskId === block.taskId && p.day === day && p.start === block.start) continue;
    if (p.day !== day) continue;
    if (start < p.end && p.start < end) return '和另一段计划重叠了';
  }

  // 不许超过任务总量
  const t = store.tasks.find((x) => x.id === block.taskId);
  if (t) {
    const others = pinsOf()
      .filter((p) => p.taskId === t.id && !(p.day === day && p.start === block.start))
      .reduce((s, p) => s + (p.end - p.start), 0);
    const left = t.estMin - (t.doneMin || 0) - others;
    if (dur > left) return `超出这件任务的总时长（最多还能排 ${fmtDur(left)}）`;
  }
  return null;
}

/** 应用一次改动：钉住、存盘、重排。成功返回 null，失败返回错误文案 */
function applyPlanEdit(block, start, dur) {
  const err = checkPlanEdit(block, start, dur);
  if (err) return err;
  removePin(block);
  pinsOf().push({ taskId: block.taskId, day: block.day, date: dateOf(block.day), start, end: start + dur });
  writeStore();
  rebuild();
  paint();
  return null;
}

function openBlockEditor(block) {
  const t = store.tasks.find((x) => x.id === block.taskId);
  if (!t) return;
  const running =
    block.day === nowDayIdx() && nowMinute() >= block.start && nowMinute() < block.end;
  const pinned = pinIndexOf(block) >= 0;

  openSheet(
    `编辑：${t.title}`,
    `<div class="field">
       <span class="field-label">开始时间${running ? '（正在进行，不能改）' : ''}</span>
       <input id="pb-start" type="time" value="${fmtClock(block.start)}" ${running ? 'disabled' : ''}>
     </div>
     <div class="field">
       <span class="field-label">时长（分钟）</span>
       <input id="pb-dur" type="number" min="5" step="5" value="${block.end - block.start}">
     </div>
     ${
       pinned
         ? '<button class="ghost-btn" id="pb-unpin">取消锁定，交给它自己排</button>'
         : '<div class="footnote">保存后这一段会被锁定，之后重排不会动它。</div>'
     }`,
    (root, close) => {
      const start = running ? block.start : toMin(root.querySelector('#pb-start').value);
      const dur = Number(root.querySelector('#pb-dur').value);
      const err = applyPlanEdit(block, start, dur);
      if (err) {
        toast(err);
        return; // 不关弹层，方便改完再试
      }
      close();
      toast('已调整，后面的计划重新排好了');
    }
  );

  const root = document.body.lastElementChild;
  const un = root.querySelector('#pb-unpin');
  if (un) {
    un.onclick = () => {
      removePin(block);
      writeStore();
      rebuild();
      paint();
      root.remove();
      toast('已取消锁定');
    };
  }
}



/* ================= 任务列表 ================= */

function renderTasks() {
  const frag = document.createDocumentFragment();
  frag.append(el(`<div class="section-title">本周任务 · ${store.tasks.length} 件</div>`));

  if (!store.tasks.length) {
    frag.append(
      el(`<div class="card muted" style="text-align:center;padding:34px 18px">还没有任务，点下面的按钮加一个。</div>`)
    );
  }

  for (const t of store.tasks) {
    const live = schedule.tasks.find((x) => x.id === t.id);
    const done = t.doneMin || 0;
    const left = Math.max(0, t.estMin - done);
    const planned = live ? live.chunks.reduce((s, c) => s + (c.end - c.start), 0) : 0;
    const finished = left <= 0;
    const ok = finished || planned >= left;
    const row = el(`
      <div class="task-item">
        <div class="task-main">
          <div class="task-title">${t.title}</div>
          <div class="task-meta">
            <span class="stars-inline">${'★'.repeat(t.stars)}${'☆'.repeat(5 - t.stars)}</span>
            · ${t.course ? t.course + ' · ' : ''}${done > 0 ? `已完成 ${fmtDur(done)} / ${fmtDur(t.estMin)}` : fmtDur(t.estMin)}
          </div>
          <div class="task-meta task-due">截止 ${(t.deadlineDate ?? dateOf(0)).slice(5)} ${t.deadlineAt == null ? '日末' : fmtClock(t.deadlineAt)}</div>
          <div class="task-plan ${ok ? 'ok' : 'bad'}">
            ${
              finished
                ? '✓ 已完成'
                : ok
                  ? `剩 ${fmtDur(left)}，已排 ${fmtDur(planned)}（${live.chunks.length} 块）`
                  : `排不下：只剩 ${fmtDur(planned)}，还需要 ${fmtDur(left)}`
            }
          </div>
        </div>
        <button class="task-del" aria-label="删除">✕</button>
      </div>`);
    row.querySelector('.task-main').onclick = () => openForm(t);
    row.querySelector('.task-del').onclick = async (e) => {
      e.stopPropagation();
      if (!(await askConfirm({ title: '删除任务', text: `「${t.title}」会被删掉，计划会重新排。`, ok: '删除', danger: true }))) return;
      store.tasks = store.tasks.filter((x) => x.id !== t.id);
      dropPinsOfTask(t.id);
      writeStore();
      rebuild();
      paint();
    };
    frag.append(row);
  }

  return frag;
}

/* ================= 表单 ================= */

let formEl = null;

function openForm(existing) {
  const t = existing ?? {
    id: null,
    title: '',
    course: '',
    stars: 3,
    estMin: 60,
    deadlineDay: null,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 45, maxChunks: 3, maxChunksPerDay: 2 },
  };

  const isFixed = t.split?.mode === 'fixed';
  // 截止可以是远期目标，不限制在本周内
  const minDate = todayStr();
  const maxDate = addDays(todayStr(), 365);
  const dDate = t.deadlineDate ?? dateOf(6);
  const dTime = t.deadlineAt == null ? '23:59' : fmtClock(t.deadlineAt);

  const recent = [...new Set(store.tasks.map((x) => x.title))]
    .filter((x) => x !== t.title)
    .slice(0, 3);

  formEl = document.createElement('div');
  formEl.innerHTML = `
    <div class="sheet-mask"></div>
    <div class="sheet">
      <div class="sheet-head">
        <button class="sheet-cancel">取消</button>
        <div class="sheet-title">${existing ? '编辑任务' : '新建任务'}</div>
        <button class="sheet-save">保存</button>
      </div>
      <div class="sheet-body">

        ${recent.length ? `<div class="field"><span class="field-label">从最近用过</span><div class="chips" id="f-recent">${recent
          .map((r) => `<button class="chip" data-title="${r}">${r}</button>`)
          .join('')}</div></div>` : ''}

        <label class="field">
          <span class="field-label">任务名</span>
          <input id="f-title" type="text" placeholder="第三章习题" value="${t.title}">
        </label>

        <label class="field">
          <span class="field-label">科目（可不填）</span>
          <input id="f-course" type="text" placeholder="线性代数" value="${t.course ?? ''}">
        </label>

        <div class="field">
          <span class="field-label">重要度</span>
          <div class="stars" id="f-stars">${[1, 2, 3, 4, 5]
            .map((i) => `<span class="star ${i <= t.stars ? 'on' : ''}" data-n="${i}">★</span>`)
            .join('')}</div>
        </div>

        <div class="field" id="f-dur-field" ${isFixed ? 'style="display:none"' : ''}>
          <span class="field-label">预计时长（分钟）</span>
          <div class="chips" id="f-dur">
            ${[30, 45, 60, 90, 120, 180]
              .map((m) => `<button class="chip ${t.estMin === m ? 'is-on' : ''}" data-m="${m}">${m}</button>`)
              .join('')}
          </div>
          <input id="f-min" type="number" inputmode="numeric" min="5" step="5" value="${t.estMin}">
        </div>

        <div class="field">
          <span class="field-label">怎么拆</span>
          <div class="chips" id="f-split">
            <button class="chip ${t.split.mode === 'none' ? 'is-on' : ''}" data-mode="none">不拆</button>
            <button class="chip ${t.split.mode === 'free' ? 'is-on' : ''}" data-mode="free">可以拆</button>
            <button class="chip ${t.split.mode === 'fixed' ? 'is-on' : ''}" data-mode="fixed">分段</button>
          </div>
        </div>

        <div class="field" id="f-seg" ${isFixed ? '' : 'style="display:none"'}>
          <span class="field-label">每次多少分钟 · 共几次</span>
          <div class="field-row">
            <input id="f-segmin" type="number" inputmode="numeric" min="5" step="5" value="${t.split.segMin ?? 15}">
            <input id="f-segnum" type="number" inputmode="numeric" min="1" step="1" value="${t.split.segments ?? 6}">
          </div>
        </div>

        <div class="field" id="f-minchunk-field" ${t.split.mode === 'free' ? '' : 'style="display:none"'}>
          <span class="field-label">每块至少多少分钟</span>
          <input id="f-minchunk" type="number" inputmode="numeric" min="15" step="5" value="${t.split.minChunkMin ?? 45}">
        </div>

        <div class="field-row">
          <label class="field">
            <span class="field-label">截止日期</span>
            <input id="f-date" type="date" min="${minDate}" max="${maxDate}" value="${dDate}">
          </label>
          <label class="field">
            <span class="field-label">截止时刻</span>
            <input id="f-time" type="time" value="${dTime}">
          </label>
        </div>

      </div>
    </div>`;

  const host = document.getElementById('app');
  host.append(formEl);
  requestAnimationFrame(() => {
    formEl?.querySelector('.sheet')?.classList.add('is-on');
    formEl?.querySelector('.sheet-mask')?.classList.add('is-on');
  });

  const $ = (s) => formEl.querySelector(s);
  let stars = t.stars;
  let mode = t.split.mode;

  $('.sheet-cancel').onclick = closeForm;
  $('.sheet-mask').onclick = closeForm;

  $('#f-stars').onclick = (e) => {
    const n = e.target?.dataset?.n;
    if (!n) return;
    stars = Number(n);
    [...$('#f-stars').children].forEach((s) => s.classList.toggle('on', Number(s.dataset.n) <= stars));
  };

  $('#f-dur').onclick = (e) => {
    const m = e.target?.dataset?.m;
    if (!m) return;
    $('#f-min').value = m;
    [...$('#f-dur').children].forEach((c) => c.classList.toggle('is-on', c.dataset.m === m));
  };

  $('#f-split').onclick = (e) => {
    const m = e.target?.dataset?.mode;
    if (!m) return;
    mode = m;
    [...$('#f-split').children].forEach((c) => c.classList.toggle('is-on', c.dataset.mode === m));
    $('#f-seg').style.display = m === 'fixed' ? '' : 'none';
    $('#f-dur-field').style.display = m === 'fixed' ? 'none' : '';
    $('#f-minchunk-field').style.display = m === 'free' ? '' : 'none';
  };

  if (recent.length) {
    $('#f-recent').onclick = (e) => {
      const title = e.target?.dataset?.title;
      if (!title) return;
      const src = store.tasks.find((x) => x.title === title);
      if (!src) return;
      $('#f-title').value = src.title;
      $('#f-course').value = src.course ?? '';
      $('#f-min').value = src.estMin;
      stars = src.stars;
      [...$('#f-stars').children].forEach((s) => s.classList.toggle('on', Number(s.dataset.n) <= stars));
      toast('已带入上次的设置');
    };
  }

  $('.sheet-save').onclick = () => {
    const title = $('#f-title').value.trim();
    if (!title) return toast('任务名不能空');

    let estMin;
    let split;
    if (mode === 'fixed') {
      const segMin = Number($('#f-segmin').value) || 15;
      const segments = Number($('#f-segnum').value) || 1;
      estMin = segMin * segments;
      split = { mode: 'fixed', segMin, segments, maxChunksPerDay: 1 };
    } else if (mode === 'none') {
      estMin = Number($('#f-min').value) || 60;
      split = { mode: 'none' };
    } else {
      estMin = Number($('#f-min').value) || 60;
      split = {
        mode: 'free',
        minChunkMin: Number($('#f-minchunk').value) || 45,
        maxChunks: 3,
        maxChunksPerDay: 2,
      };
    }

    const dateStr = $('#f-date').value || dateOf(6);
    const [hh, mm] = ($('#f-time').value || '23:59').split(':').map(Number);

    const next = {
      id: t.id ?? 't' + Date.now().toString(36),
      title,
      course: $('#f-course').value.trim() || null,
      stars,
      estMin,
      deadlineDate: dateStr,
      deadlineAt: hh * 60 + mm,
      split,
    };

    const i = store.tasks.findIndex((x) => x.id === next.id);
    if (i >= 0) store.tasks[i] = next;
    else store.tasks.push(next);

    writeStore();
    rebuild();
    closeForm();
    paint();
    toast(existing ? '已更新' : '已添加');
  };
}

function closeForm() {
  formEl?.remove();
  formEl = null;
}

/* ================= 统计 ================= */

const ymdLocal = (d) =>
  d.getFullYear() +
  '-' +
  String(d.getMonth() + 1).padStart(2, '0') +
  '-' +
  String(d.getDate()).padStart(2, '0');

function statLogs() {
  return (store.log || []).filter((x) => x.kind === 'done' && (x.actualMin || x.minutes));
}

function isOnTime(x) {
  try {
    // 用绝对日期：跨周滚动后 x.day 会是负数，dateOf 只能拿它当相对索引算
    const end = new Date((x.date ?? dateOf(x.day)) + 'T00:00:00').getTime() + x.end * 60000;
    return x.at <= end;
  } catch {
    return false;
  }
}

function streakDays(logs) {
  const set = new Set(logs.map((x) => ymdLocal(new Date(x.at))));
  let n = 0;
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  while (set.has(ymdLocal(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderStats() {
  const frag = document.createDocumentFragment();

  frag.append(el(`<div class="seg seg-sub" id="stat-range">
      <button class="seg-btn is-on" data-r="7">最近 7 天</button>
      <button class="seg-btn" data-r="30">最近 30 天</button>
    </div>`));

  const body = document.createElement('div');
  frag.append(body);

  const paintStats = (days) => {
    body.textContent = '';
    const logs = statLogs();
    const DAY = 86400000;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const from = today0.getTime() - (days - 1) * DAY;
    const win = logs.filter((x) => x.at >= from);

    if (!logs.length) {
      body.append(
        el(`<div class="card muted" style="text-align:center;padding:44px 18px;margin-top:12px">
              还没有记录。<br>在「现在」页点一次「完成」，这里就开始有数了。
            </div>`)
      );
      return;
    }

    const totalMin = win.reduce((s, x) => s + (x.actualMin || x.minutes || 0), 0);
    const count = win.length;
    const onTime = win.filter(isOnTime).length;
    const rate = count ? Math.round((onTime / count) * 100) : 0;

    body.append(
      el(`<div class="card" style="margin-top:12px;text-align:center;padding:24px 18px">
            <div class="stat-big">${totalMin ? fmtDur(totalMin) : '0m'}</div>
            <div class="muted" style="font-size:13px;margin-top:2px">专注时长</div>
          </div>`)
    );

    body.append(
      el(`<div class="stat-trio">
            <div><b>${count}</b><span>完成段</span></div>
            <div><b>${rate}%</b><span>按时率</span></div>
            <div><b>${streakDays(logs)}</b><span>连续天</span></div>
          </div>`)
    );

    /* 每日柱状 */
    const cols = [];
    const N = Math.min(days, 14);
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(today0.getTime() - i * DAY);
      const key = ymdLocal(d);
      const mins = win
        .filter((x) => ymdLocal(new Date(x.at)) === key)
        .reduce((s, x) => s + (x.actualMin || x.minutes || 0), 0);
      cols.push({ mins, label: '日一二三四五六'[d.getDay()] });
    }
    const peak = Math.max(1, ...cols.map((c) => c.mins));

    body.append(el(`<div class="section-title">每天</div>`));
    const bars = el(`<div class="bars"></div>`);
    for (const c of cols) {
      const h = c.mins ? Math.max(8, Math.round((c.mins / peak) * 100)) : 3;
      bars.append(
        el(`<div class="b">
              <i class="${c.mins ? '' : 'zero'}" style="height:${h}%" title="${fmtDur(c.mins)}"></i>
              <span>${c.label}</span>
            </div>`)
      );
    }
    body.append(bars);

    /* 科目分布 */
    const byCourse = new Map();
    for (const x of win) {
      const t = store.tasks.find((v) => v.id === x.taskId);
      const k = t?.course || '未分类';
      byCourse.set(k, (byCourse.get(k) || 0) + (x.actualMin || x.minutes || 0));
    }
    const subs = [...byCourse.entries()].sort((a, b) => b[1] - a[1]);
    if (subs.length) {
      body.append(el(`<div class="section-title">花在哪</div>`));
      const maxSub = Math.max(1, ...subs.map((s) => s[1]));
      for (const [name, mins] of subs) {
        body.append(
          el(`<div class="sub-row">
                <span class="sub-name">${name}</span>
                <span class="sub-track"><i style="width:${Math.round((mins / maxSub) * 100)}%"></i></span>
                <span class="sub-val">${fmtDur(mins)}</span>
              </div>`)
        );
      }
    }

    /* 累计 */
    const allMin = logs.reduce((s, x) => s + (x.actualMin || x.minutes || 0), 0);
    const doneTasks = store.tasks.filter((t) => (t.doneMin || 0) >= t.estMin).length;
    body.append(el(`<div class="section-title">累计</div>`));
    body.append(
      el(`<div class="card">
            <div class="cum-row"><span>总专注</span><b>${fmtDur(allMin)}</b></div>
            <div class="cum-row"><span>完成段</span><b>${logs.length}</b></div>
            <div class="cum-row"><span>做完的任务</span><b>${doneTasks}</b></div>
          </div>`)
    );

    body.append(el(`<div class="footnote">只统计真正打了勾的段</div>`));
  };

  const seg = frag.querySelector('#stat-range');
  let days = 7;
  paintStats(days);
  seg.onclick = (e) => {
    const r = e.target?.dataset?.r;
    if (!r) return;
    days = Number(r);
    [...seg.querySelectorAll('.seg-btn')].forEach((b) =>
      b.classList.toggle('is-on', b.dataset.r === r)
    );
    paintStats(days);
  };

  return frag;
}

/* ================= 主题 ================= */

const THEMES = [
  { key: 'indigo', name: '靛蓝', a: '#5B7CFA', b: '#8B5CF6' },
  { key: 'violet', name: '紫罗兰', a: '#8B5CF6', b: '#D946EF' },
  { key: 'teal', name: '青碧', a: '#0EA5A5', b: '#22D3EE' },
  { key: 'rose', name: '蔷薇', a: '#F0508A', b: '#FB7185' },
  { key: 'amber', name: '琥珀', a: '#F59E0B', b: '#FB923C' },
  // 风景 / 动物：靠渐变 + 原创 SVG 剪影成立，不含任何图片
  { key: 'coast', name: '海岸', a: '#2F88B8', b: '#8ECBE8', bg: 'linear-gradient(180deg,#eaf7ff 0%,#d3ecf8 40%,#a8d8ee 62%,#f2ead9 100%)', art: 'coast', ink: '#14384a' },
  { key: 'snow', name: '雪原', a: '#6E93B8', b: '#A9C6DF', bg: 'linear-gradient(180deg,#f6fafd 0%,#e0ecf6 52%,#c6daea 100%)', art: 'snow', ink: '#1b2a38' },
  { key: 'crane', name: '丹顶鹤', a: '#B3202A', b: '#D9736F', bg: 'linear-gradient(180deg,#fcfcfa 0%,#f1f0ec 58%,#e6e5df 100%)', art: 'crane', ink: '#2a2a26' },
  { key: 'shiba', name: '柴犬', a: '#C96A1F', b: '#E79A4A', bg: 'linear-gradient(180deg,#fff8ef 0%,#f9e6cd 58%,#f0d5b0 100%)', art: 'shiba', ink: '#432a12' },
];

/** 每个主题的原创剪影（纯 SVG 手绘路径，无版权问题）。越抽象越好认。 */
const BG_ART = {
  coast: `<svg viewBox="0 0 360 800" preserveAspectRatio="xMidYMax slice">
      <path d="M0 600 Q60 588 120 596 T240 592 T360 598 V800 H0 Z" fill="currentColor" opacity=".10"/>
      <path d="M0 660 Q70 646 140 656 T280 652 T360 658 V800 H0 Z" fill="currentColor" opacity=".14"/>
      <circle cx="288" cy="150" r="24" fill="currentColor" opacity=".10"/>
    </svg>`,
  snow: `<svg viewBox="0 0 360 800" preserveAspectRatio="xMidYMax slice">
      <path d="M0 620 Q80 556 152 614 T360 578 V800 H0 Z" fill="currentColor" opacity=".10"/>
      <path d="M0 690 Q90 650 172 682 T360 660 V800 H0 Z" fill="currentColor" opacity=".14"/>
      <circle cx="84" cy="210" r="2.5" fill="currentColor" opacity=".22"/>
      <circle cx="128" cy="162" r="2" fill="currentColor" opacity=".22"/>
      <circle cx="266" cy="228" r="2.5" fill="currentColor" opacity=".22"/>
    </svg>`,
  crane: `<svg viewBox="0 0 360 800" preserveAspectRatio="xMidYMax slice">
      <g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".16">
        <path d="M96 660 q20 -14 40 -2 q20 -12 40 2"/>
        <path d="M196 716 q16 -11 32 -2 q16 -9 32 2"/>
        <path d="M256 640 q12 -9 24 -1 q12 -8 24 1"/>
      </g>
      <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".10">
        <path d="M40 748 q14 -10 28 -1 q14 -9 28 1"/>
        <path d="M300 770 q12 -8 24 -1 q12 -7 24 1"/>
      </g>
    </svg>`,
  shiba: `<svg viewBox="0 0 360 800" preserveAspectRatio="xMidYMax slice">
      <g fill="currentColor" opacity=".11">
        <g transform="translate(150 640) rotate(-12)">
          <ellipse cx="0" cy="14" rx="20" ry="16"/>
          <ellipse cx="-24" cy="-6" rx="7" ry="9"/>
          <ellipse cx="-8" cy="-14" rx="7" ry="9"/>
          <ellipse cx="10" cy="-14" rx="7" ry="9"/>
          <ellipse cx="26" cy="-6" rx="7" ry="9"/>
        </g>
        <g transform="translate(240 726) rotate(10) scale(.8)">
          <ellipse cx="0" cy="14" rx="20" ry="16"/>
          <ellipse cx="-24" cy="-6" rx="7" ry="9"/>
          <ellipse cx="-8" cy="-14" rx="7" ry="9"/>
          <ellipse cx="10" cy="-14" rx="7" ry="9"/>
          <ellipse cx="26" cy="-6" rx="7" ry="9"/>
        </g>
        <g transform="translate(86 760) rotate(-20) scale(.62)">
          <ellipse cx="0" cy="14" rx="20" ry="16"/>
          <ellipse cx="-24" cy="-6" rx="7" ry="9"/>
          <ellipse cx="-8" cy="-14" rx="7" ry="9"/>
          <ellipse cx="10" cy="-14" rx="7" ry="9"/>
          <ellipse cx="26" cy="-6" rx="7" ry="9"/>
        </g>
      </g>
    </svg>`,
};

function mixHex(hex, ratio) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const m = (v) => Math.round(v + (255 - v) * ratio);
  return '#' + [m(r), m(g), m(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function applyTheme() {
  const t = THEMES.find((x) => x.key === (store.theme || 'indigo')) || THEMES[0];
  const s = document.documentElement.style;
  s.setProperty('--accent', t.a);
  s.setProperty('--accent-2', t.b);
  s.setProperty('--tint', mixHex(t.a, 0.86));
  s.setProperty('--tint-2', mixHex(t.b, 0.9));

  // 风景 / 动物主题：一层渐变 + 一个原创剪影（纯 CSS/SVG，零图片）
  const bg = document.getElementById('bg');
  const art = document.getElementById('bg-art');
  if (t.bg) {
    document.documentElement.dataset.scene = 'on';
    if (bg) bg.style.background = t.bg;
    if (art) {
      art.innerHTML = BG_ART[t.art] || '';
      art.style.color = t.ink || t.a;
    }
  } else {
    document.documentElement.removeAttribute('data-scene');
    if (bg) bg.style.background = '';
    if (art) art.innerHTML = '';
  }
}

/* ================= 「考卷」皮肤（实验，默认关） ================= */

const SKIN_EXAM = 'exam';
const SKIN_GLASS = 'glass';
const uiMode = () => (store.uiMode === SKIN_EXAM || store.uiMode === SKIN_GLASS ? store.uiMode : 'plain');

/**
 * 皮肤是「可拆卸的外挂」：打开时插一个 link，关掉时删掉。
 * 不加载 = 完全不影响原界面，连字节都不多。
 */
const SKIN_FILES = { exam: 'skin-exam.css', glass: 'skin-glass.css' };

function applySkin() {
  const mode = uiMode();
  document.documentElement.dataset.ui = mode === 'plain' ? '' : mode;
  for (const [key, href] of Object.entries(SKIN_FILES)) {
    const id = 'skin-' + key;
    const link = document.getElementById(id);
    const want = mode === key;
    if (want && !link) {
      const el = document.createElement('link');
      el.id = id;
      el.rel = 'stylesheet';
      el.href = href;
      document.head.append(el);
    } else if (!want && link) {
      link.remove();
    }
  }
}

/** 贴纸：绝对定位的装饰，pointer-events:none，不占布局。位置贴着卡片边缘，别压按钮 */
const STICKER_POS = ['right:10px;top:-10px', 'left:-8px;top:-12px', 'right:22px;bottom:-10px'];
function sticker(kind, posIdx, text) {
  const label = kind === 'note' ? text || '背！' : kind === 'arrow' ? '↗' : '';
  return `<span class="sticker ${kind}" style="${STICKER_POS[posIdx % STICKER_POS.length]}">${label}</span>`;
}

/** 打勾后盖一个「已阅」章（1.3 秒自动消失） */
function flashStamp() {
  if (uiMode() !== SKIN_EXAM) return;
  const card = document.querySelector('.now-card');
  if (!card) return;
  const d = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const s = document.createElement('div');
  s.className = 'exam-stamp';
  s.innerHTML = `已 阅<small>${dateOf(nowDayIdx()).slice(5)} ${hm}</small>`;
  card.append(s);
  setTimeout(() => s.remove(), 1400);
}

/* ================= 帮助 ================= */

function openHelp() {
  openSheet(
    '怎么用',
    `<div class="help">
      <h4>它解决什么</h4>
      <p>普通待办只给你一个倒计时。这个 App 知道你的课表和空档，会算「这活还塞不塞得下」，然后把它排进具体时段。</p>

      <h4>现在</h4>
      <p>打开就看到此刻该做什么、还剩多少。两件事拖到明天：点「完成」记账；点「延后」把这一段往后推 30 分钟。</p>

      <h4>计划</h4>
      <p>未来 7 天的时间轴。灰色是课和已经占掉的时间，靛蓝色是排进去的任务。顶部会告诉你可用多少、最多排多少、留白多少。</p>

      <h4>任务</h4>
      <p>点一行改，点 ✕ 删。每件任务要填：重要度（1–5 星）、预计时长、截止时间。<br>
      「怎么拆」有三种：不拆（必须一次做完）、可以拆（系统按空档切）、分段（你自己定每次几分钟 × 几次）。</p>

      <h4>统计</h4>
      <p>只统计真正打了勾的段。专注时长用的是实际用时，不是计划长度。按时率 = 在计划结束前打完勾的比例。</p>

      <h4>排程怎么算的</h4>
      <p><b>紧急度</b>看「剩余工作量 ÷ 截止前你还有多少空」，不是看离截止几天。所以「三天后交但你这三天没空」会比「下周交但下周很空」更急。</p>
      <p><b>重要度</b>是你打的星，做了非线性拉伸，4–5 星更有分量。</p>
      <p>两者按一根滑杆加权，可以在设置里调。<b>留白</b>是每天最多只用掉 85% 的空档，剩下的留给意外。每节课前后还各留 10 分钟赶路。</p>

      <h4>没做完怎么办</h4>
      <p>计划块时间一过、你还没打勾，它就会进「待处理」。四个选择：完成了 / 顺延 / 改剩余 / 删除。</p>
      <p>计划块进行中不提供「部分完成」——那是超时之后的补救，不是随时可以摆烂的出口。</p>

      <h4>时间模板与固定占用</h4>
      <p>模板是「我能用的时间」，按天多段填。午饭、通勤就靠把时段断开让出来。<br>
      固定占用是「已经被占掉的时间」：课表、社团、班会。学期课会跟着学期开关一起失效。</p>

      <h4>数据</h4>
      <p>存在 app 私有目录，卸载会清空。设置里可以导出 JSON 备份。</p>
    </div>`,
    (root, close) => close()
  );
  // 帮助只读，去掉「保存」按钮
  const root = document.body.lastElementChild;
  const save = root.querySelector('.sheet-save');
  if (save) save.style.display = 'none';
  const title = root.querySelector('.sheet-title');
  if (title) title.style.textAlign = 'center';
}


/* ================= 诊断页 ================= */

function buildDiagReport() {
  const L = [];
  const now = new Date();
  L.push('time-assistant 诊断报告');
  // 版本号排在前面：没有它，多版本之后收到报告也分不清是哪一版
  L.push('版本: ' + VERSION + ' (' + VERSION_CODE + ')');
  L.push('时间: ' + now.toLocaleString());
  L.push('时区: ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || '?') + '  偏移: ' + -now.getTimezoneOffset() / 60 + 'h');
  L.push('平台: ' + navigator.userAgent);
  L.push('屏幕: ' + window.innerWidth + '×' + window.innerHeight + ' dpr=' + (window.devicePixelRatio || 1));
  L.push('存储: ' + (bridge && bridge.load ? '原生文件' : 'localStorage'));
  L.push('起点: ' + store.startDate + '  窗口: ' + spanDays() + ' 天  主题: ' + (store.theme || '-'));
  L.push('任务: ' + (store.tasks || []).length + ' 件，完成记录 ' + (store.log || []).length + ' 条，待处理 ' + (store.pending || []).length + ' 段');
  L.push('课表: ' + (store.fixed || []).length + ' 条固定占用，学期' + (store.semester?.enabled === false ? '关' : '开'));
  L.push('数据大小: ' + Math.round(JSON.stringify(store).length / 1024) + ' KB');
  L.push('');
  try {
    const crash = bridge && bridge.crashLog ? bridge.crashLog() : '';
    if (crash) {
      L.push('— 原生崩溃 —');
      L.push(crash);
      L.push('');
    }
  } catch (e) {}
  const logs = (store.diag || []).slice(-40);
  L.push('— 应用日志（最近 ' + logs.length + ' 条）—');
  if (!logs.length) L.push('（无）');
  for (const x of logs) {
    L.push(new Date(x.t).toLocaleTimeString() + ' [' + x.level + '] ' + x.msg);
  }
  return L.join('\n');
}

function openDiag() {
  const text = buildDiagReport();
  openSheet(
    '诊断',
    `<div class="field">
       <span class="field-label">点下方按钮复制，或长按文字全选</span>
       <textarea class="diag-box" readonly rows="18">${text.replace(/</g, '&lt;')}</textarea>
     </div>
     <button class="ghost-btn" id="diag-copy">复制报告</button>
     <button class="ghost-btn" id="diag-export">导出报告</button>`,
    (root, close) => close()
  );
  const root = document.body.lastElementChild;
  const save = root.querySelector('.sheet-save');
  if (save) save.style.display = 'none';
  const btn = root.querySelector('#diag-copy');
  if (btn) {
    btn.onclick = async () => {
      const ok = await copyText(text);
      toast(ok ? '已复制，去 GitHub 建 issue 直接粘贴' : '复制失败，长按上面的文字手动全选');
    };
  }
  const ex = root.querySelector('#diag-export');
  if (ex) {
    ex.onclick = () => {
      const t = new Date();
      const stamp = String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0');
      exportText(`diagnostic-${todayStr()}-${stamp}.txt`, 'text/plain', text);
    };
  }
}

/* ================= 设置 ================= */

const toMin = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const toTime = (m) =>
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/** 自绘确认框（替掉原生 confirm：它会带一行「网址为 http://… 的网页显示」） */
function askConfirm(opts = {}) {
  const { title = '确认', text = '', ok = '确定', cancel = '取消', danger = false } = opts;
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="sheet-mask"></div>
      <div class="confirm-wrap"><div class="confirm">
        <div class="confirm-title">${title}</div>
        <div class="confirm-text">${text}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-r="0">${cancel}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${ok}</button>
        </div>
      </div></div>`;
    document.body.append(root);
    const done = (v) => {
      root.remove();
      resolve(v);
    };
    root.querySelectorAll('.confirm-actions button').forEach((b) => {
      b.onclick = () => done(b.dataset.r === '1');
    });
    root.querySelector('.sheet-mask').onclick = () => done(false);
  });
}
/** 可折叠区块：标题行点击展开/收起 */
function foldSection(title, sub, open, build) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="fold-head ${open ? 'is-open' : ''}">
      <span class="fold-title">${title}${sub ? ' · ' + sub : ''}</span>
      <span class="fold-chev">›</span>
    </div>
    <div class="fold-body ${open ? 'is-open' : ''}"></div>`;
  const head = wrap.querySelector('.fold-head');
  const body = wrap.querySelector('.fold-body');
  build(body);
  head.onclick = () => {
    head.classList.toggle('is-open');
    body.classList.toggle('is-open');
  };
  return wrap;
}

/** 通用底部弹层 */
function openSheet(title, bodyHTML, onSave) {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="sheet-mask"></div>
    <div class="sheet">
      <div class="sheet-head">
        <button class="sheet-cancel">取消</button>
        <div class="sheet-title">${title}</div>
        <button class="sheet-save">保存</button>
      </div>
      <div class="sheet-body">${bodyHTML}</div>
    </div>`;
  document.body.append(root);
  requestAnimationFrame(() => {
    root.querySelector('.sheet')?.classList.add('is-on');
    root.querySelector('.sheet-mask')?.classList.add('is-on');
  });
  const close = () => root.remove();
  root.querySelector('.sheet-cancel').onclick = close;
  root.querySelector('.sheet-mask').onclick = close;
  root.querySelector('.sheet-save').onclick = () => onSave(root, close);
  return root;
}

/* --- 时间模板 --- */

function openTemplateEditor(wd) {
  const list = (store.template[String(wd)] ?? []).map(([a, b]) => [a, b]);
  const rowsHTML = list
    .map(
      ([a, b]) => `
      <div class="seg-row">
        <input type="time" class="t-a" value="${toTime(a)}">
        <span class="dash">–</span>
        <input type="time" class="t-b" value="${toTime(b)}">
        <button class="seg-del">✕</button>
      </div>`
    )
    .join('');

  const defScope = wd <= 5 ? 'work' : 'weekend';

  openSheet(
    WD[wd] + '的时间段',
    `<div class="field">
       <span class="field-label">改完应用到</span>
       <div class="chips" id="seg-scope">
         <button class="chip" data-s="one">只改${WD[wd]}</button>
         <button class="chip ${defScope === 'work' ? 'is-on' : ''}" data-s="work">工作日</button>
         <button class="chip ${defScope === 'weekend' ? 'is-on' : ''}" data-s="weekend">周末</button>
         <button class="chip" data-s="all">全部七天</button>
       </div>
     </div>
     <div class="field">
       <span class="field-label">这段留给 App 安排（午饭、通勤就靠断开它留出）</span>
       <div id="seg-list">${rowsHTML}</div>
       <button class="ghost-btn" id="seg-add">＋ 加一段</button>
     </div>`,
    (root, close) => {
      const out = [];
      for (const row of root.querySelectorAll('.seg-row')) {
        const a = toMin(row.querySelector('.t-a').value);
        const b = toMin(row.querySelector('.t-b').value);
        if (b > a) out.push([a, b]);
      }
      out.sort((x, y) => x[0] - y[0]);
      const scope = root.querySelector('#seg-scope .chip.is-on')?.dataset.s ?? 'one';
      const targets =
        scope === 'work' ? [1, 2, 3, 4, 5]
        : scope === 'weekend' ? [6, 7]
        : scope === 'all' ? [1, 2, 3, 4, 5, 6, 7]
        : [wd];
      for (const t of targets) store.template[String(t)] = JSON.parse(JSON.stringify(out));
      writeStore();
      rebuild();
      close();
      paint();
      toast('已更新 ' + targets.length + ' 天');
    }
  );

  const root = document.body.lastElementChild;
  const listEl = root.querySelector('#seg-list');

  root.querySelector('#seg-scope').onclick = (e) => {
    const s2 = e.target?.dataset?.s;
    if (!s2) return;
    [...root.querySelectorAll('#seg-scope .chip')].forEach((c) =>
      c.classList.toggle('is-on', c.dataset.s === s2)
    );
  };

  root.querySelector('#seg-add').onclick = () => {
    const d = document.createElement('div');
    d.className = 'seg-row';
    d.innerHTML = `<input type="time" class="t-a" value="19:00">
                   <span class="dash">–</span>
                   <input type="time" class="t-b" value="21:00">
                   <button class="seg-del">✕</button>`;
    listEl.append(d);
  };

  listEl.onclick = (e) => {
    if (e.target.classList.contains('seg-del')) e.target.closest('.seg-row').remove();
  };
}

/* --- 固定占用 --- */

const kindLabel = (b) => {
  const k = b.kind ?? (b.date != null ? 'once' : b.weeks != null ? 'semester' : 'weekly');
  return k === 'once' ? '一次性' : k === 'semester' ? '学期课' : '每周';
};

function openFixedEditor(idx) {
  const b = idx == null ? null : store.fixed[idx];
  const kind = b == null ? 'weekly' : b.kind ?? (b.date != null ? 'once' : b.weeks != null ? 'semester' : 'weekly');
  const picked0 = b ? b.weekdays ?? (b.weekday != null ? [b.weekday] : [1]) : [1];
  const date = b?.date ?? todayStr();
  const weeks = b?.weeks ?? '1-17';

  const root = openSheet(
    b ? '编辑占用' : '添加占用',
    `<label class="field">
       <span class="field-label">名称</span>
       <input id="x-name" type="text" value="${b?.label ?? ''}" placeholder="社团活动">
     </label>
     <div class="field">
       <span class="field-label">哪种</span>
       <div class="chips" id="x-kind">
         <button class="chip ${kind === 'weekly' ? 'is-on' : ''}" data-k="weekly">每周</button>
         <button class="chip ${kind === 'once' ? 'is-on' : ''}" data-k="once">一次性</button>
         <button class="chip ${kind === 'semester' ? 'is-on' : ''}" data-k="semester">学期课</button>
       </div>
     </div>
     <div class="field" id="x-wd-field">
       <span class="field-label">星期（可多选）</span>
       <div class="chips" id="x-wd">
         ${[1, 2, 3, 4, 5, 6, 7]
           .map((x) => `<button class="chip ${picked0.includes(x) ? 'is-on' : ''}" data-d="${x}">${WD[x]}</button>`)
           .join('')}
       </div>
     </div>
     <label class="field" id="x-date-field">
       <span class="field-label">日期</span>
       <input id="x-date" type="date" value="${date}">
     </label>
     <label class="field" id="x-weeks-field">
       <span class="field-label">周次（1-17 / 2-16/双 / 1,3,5）</span>
       <input id="x-weeks" type="text" value="${weeks}">
     </label>
     <div class="field-row">
       <label class="field"><span class="field-label">开始</span>
         <input id="x-start" type="time" value="${toTime(b?.start ?? 1140)}"></label>
       <label class="field"><span class="field-label">结束</span>
         <input id="x-end" type="time" value="${toTime(b?.end ?? 1260)}"></label>
     </div>
     ${b ? '<button class="ghost-btn danger" id="x-del">删除这条占用</button>' : ''}`,
    (r, close) => {
      const label = r.querySelector('#x-name').value.trim();
      if (!label) return toast('名称不能空');
      const k = r.querySelector('#x-kind .chip.is-on')?.dataset.k ?? 'weekly';
      const next = {
        kind: k,
        label,
        start: toMin(r.querySelector('#x-start').value),
        end: toMin(r.querySelector('#x-end').value),
      };
      if (next.end <= next.start) return toast('结束时间要晚于开始');
      if (k === 'once') {
        next.date = r.querySelector('#x-date').value;
      } else {
        const picked = [...r.querySelectorAll('#x-wd .chip.is-on')].map((c) => Number(c.dataset.d));
        if (!picked.length) return toast('至少选一天');
        next.weekdays = picked.sort((x, y) => x - y);
      }
      if (k === 'semester') next.weeks = r.querySelector('#x-weeks').value.trim() || 'all';

      if (idx == null) store.fixed.push(next);
      else store.fixed[idx] = next;
      writeStore();
      rebuild();
      close();
      paint();
      toast('已保存');
    }
  );

  const sync = () => {
    const k = root.querySelector('#x-kind .chip.is-on')?.dataset.k ?? 'weekly';
    root.querySelector('#x-wd-field').style.display = k === 'once' ? 'none' : '';
    root.querySelector('#x-weeks-field').style.display = k === 'semester' ? '' : 'none';
    root.querySelector('#x-date-field').style.display = k === 'once' ? '' : 'none';
  };
  sync();

  const wdBox = root.querySelector('#x-wd');
  if (wdBox) {
    wdBox.onclick = (e) => {
      if (e.target?.dataset?.d) e.target.classList.toggle('is-on');
    };
  }

  root.querySelector('#x-kind').onclick = (e) => {
    const k = e.target.dataset?.k;
    if (!k) return;
    [...root.querySelectorAll('#x-kind .chip')].forEach((c) => c.classList.toggle('is-on', c.dataset.k === k));
    sync();
  };

  const del = root.querySelector('#x-del');
  if (del) {
    del.onclick = async () => {
      if (!(await askConfirm({ title: '删除占用', text: '这条固定占用会被移除，课表之外的时间会重新参与排程。', ok: '删除', danger: true }))) return;
      store.fixed.splice(idx, 1);
      writeStore();
      rebuild();
      root.remove();
      paint();
      toast('已删除');
    };
  }
}

/* --- 设置页 --- */

function renderSettings() {
  const frag = document.createDocumentFragment();

  /* 学期 */
  const sem = store.semester ?? { enabled: true, startDate: todayStr(), totalWeeks: 17, label: '学期' };
  store.semester = sem;
  const wk = sem.enabled === false ? null : semesterWeekNo(sem, todayStr());
  const semCard = el(`
    <div class="card" style="margin-bottom:10px">
      <div class="set-row">
        <div>
          <div class="set-title">学期</div>
          <div class="set-sub">${sem.enabled === false ? '关着：课表不占用任何时间' : `第 ${wk ?? '—'} 周 / 共 ${sem.totalWeeks} 周`}</div>
        </div>
        <button class="switch ${sem.enabled === false ? '' : 'on'}" id="sem-toggle"><i></i></button>
      </div>
      <div class="set-form">
        <label class="field"><span class="field-label">开学日期</span>
          <input id="sem-start" type="date" value="${sem.startDate}"></label>
        <label class="field"><span class="field-label">总周数</span>
          <input id="sem-weeks" type="number" min="1" max="30" value="${sem.totalWeeks}"></label>
      </div>
    </div>`);
  semCard.querySelector('#sem-toggle').onclick = () => {
    sem.enabled = sem.enabled === false;
    writeStore();
    rebuild();
    paint();
    toast(sem.enabled ? '开学模式' : '放假模式：课表已关闭');
  };
  semCard.querySelector('#sem-start').onchange = (e) => {
    sem.startDate = e.target.value;
    writeStore();
    rebuild();
    paint();
  };
  semCard.querySelector('#sem-weeks').onchange = (e) => {
    sem.totalWeeks = Number(e.target.value) || 17;
    writeStore();
    rebuild();
    paint();
  };
  frag.append(semCard);

  /* 时间模板（折叠） */
  const tplTotal = baseFree.reduce((a, b) => a + b, 0);
  frag.append(
    foldSection(`时间模板`, `本周可用 ${fmtDur(tplTotal)}`, false, (body) => {
      for (let d = 0; d < 7; d++) {
        const wd = d + 1;
        const segs = store.template[String(wd)] ?? [];
        const row = el(`
          <div class="set-row clickable">
            <div>
              <div class="set-title">${WD[wd]}</div>
              <div class="set-sub">${segs.length ? segs.map(([a, b]) => `${toTime(a)}–${toTime(b)}`).join(' · ') : '不安排'}</div>
            </div>
            <span class="chev">›</span>
          </div>`);
        row.onclick = () => openTemplateEditor(wd);
        body.append(row);
      }
    })
  );

  /* 固定占用（折叠） */
  frag.append(
    foldSection(`固定占用`, `${store.fixed.length} 条`, false, (body) => {
      store.fixed.forEach((b, i) => {
        const when =
          (b.kind === 'once' || b.date != null)
            ? `${(b.date ?? '').slice(5)}`
            : (b.weekdays ?? (b.weekday != null ? [b.weekday] : [])).map((x) => WD[x]).join('、');
        const row = el(`
          <div class="set-row clickable">
            <div>
              <div class="set-title">${b.label}</div>
              <div class="set-sub">${when} ${toTime(b.start)}–${toTime(b.end)} · ${kindLabel(b)}${b.weeks ? ' · ' + b.weeks : ''}</div>
            </div>
            <span class="chev">›</span>
          </div>`);
        row.onclick = () => openFixedEditor(i);
        body.append(row);
      });
      const add = el(`<button class="ghost-btn" style="margin:2px 0 14px">＋ 添加固定占用（社团、会议、活动）</button>`);
      add.onclick = () => openFixedEditor(null);
      body.append(add);
    })
  );

  /* 主题 */
  frag.append(el(`<div class="section-title">主题</div>`));
  const themeCard = el(`<div class="theme-grid" id="theme-dots">${THEMES.map(
    (t) => `<button class="theme-tile ${t.key === (store.theme || 'indigo') ? 'is-on' : ''}" data-k="${t.key}">
        <span class="tile-swatch" style="background:${t.bg || `linear-gradient(135deg,${t.a},${t.b})`}"></span>
        <span class="tile-name">${t.name}</span>
      </button>`
  ).join('')}</div>`);
  // 注意：themeCard 自己就是网格（id 在它身上），querySelector 只找子节点，所以直接绑
  themeCard.onclick = (e) => {
    const k = e.target?.closest?.('.theme-tile')?.dataset?.k;
    if (!k) return;
    store.theme = k;
    writeStore();
    applyTheme();
    paint();
  };
  frag.append(themeCard);

  /* 实验（整活层，默认关） */
  frag.append(el(`<div class="section-title">界面风格</div>`));
  const skinMode = uiMode();
  const skinHint =
    skinMode === 'glass'
      ? '玻璃风格：浅色毛玻璃卡片 + 雾蓝强调色，主题色会被固定'
      : skinMode === 'exam'
        ? '考卷模式使用固定配色，关掉后主题颜色会恢复'
        : '普通：跟随下方主题';
  const skinCard = el(`<div class="card">
      <div class="chips" id="skin-chips">
        ${[['plain', '普通'], ['glass', '玻璃'], ['exam', '考卷']]
          .map(([k, label]) => `<button class="chip ${skinMode === k ? 'is-on' : ''}" data-s="${k}">${label}</button>`)
          .join('')}
      </div>
      <div class="footnote" style="margin-top:10px">${skinHint}</div>
    </div>`);
  skinCard.querySelector('#skin-chips').onclick = (e) => {
    const k = e.target?.closest?.('.chip')?.dataset?.s;
    if (!k) return;
    store.uiMode = k;
    writeStore();
    applySkin();
    paint();
    toast(k === 'plain' ? '已恢复普通界面' : k === 'glass' ? '玻璃风格已开启' : '考卷模式已开启');
  };
  frag.append(skinCard);

  /* 帮助 */
  frag.append(el(`<div class="section-title">帮助</div>`));
  const helpRow = el(`<div class="set-row clickable">
      <div><div class="set-title">怎么用</div><div class="set-sub">规则、术语、每个页面做什么</div></div>
      <span class="chev">›</span></div>`);
  helpRow.onclick = openHelp;
  frag.append(helpRow);

  const diagRow = el(`<div class="set-row clickable">
      <div><div class="set-title">诊断</div><div class="set-sub">出错时把这段发我，能定位问题</div></div>
      <span class="chev">›</span></div>`);
  diagRow.onclick = openDiag;
  frag.append(diagRow);

  /* 数据 */
  frag.append(el(`<div class="section-title">数据</div>`));
  const dataCard = el(`
    <div class="card">
      <button class="ghost-btn" id="do-test">测试通知（10 秒后）</button>
      <button class="ghost-btn" id="do-export">导出 JSON（备份）</button>
      <button class="ghost-btn" id="do-import">导入 JSON（恢复备份）</button>
      <button class="ghost-btn danger" id="do-reset">清空所有任务</button>
    </div>`);
  dataCard.querySelector('#do-test').onclick = () => {
    if (bridge && bridge.testNotify) {
      bridge.testNotify();
      toast('10 秒后应该会响，可以先把 App 切到后台');
    } else {
      toast('网页版没有系统通知');
    }
  };
  dataCard.querySelector('#do-export').onclick = () => {
    exportText(`scheduler-${todayStr()}.json`, 'application/json', JSON.stringify(store, null, 2));
  };
  dataCard.querySelector('#do-import').onclick = () => pickImportFile();
  dataCard.querySelector('#do-reset').onclick = async () => {
    if (!(await askConfirm({ title: '清空任务', text: '所有任务和完成记录都会删掉，课表和时间模板保留。', ok: '清空', danger: true }))) return;
    store.tasks = [];
    store.log = [];
    store.pending = [];
    store.lastPlan = [];
    writeStore();
    rebuild();
    paint();
    toast('已清空任务');
  };
  frag.append(dataCard);

  frag.append(el(`<div class="footnote">改模板或占用后，计划会立刻重排</div>`));
  return frag;
}

/** 学期第几周（设置页用，和引擎同一算法） */
function semesterWeekNo(sem, dateStr) {
  if (!sem) return null;
  const w =
    Math.floor(
      (Date.parse(dateStr + 'T00:00:00Z') - Date.parse(sem.startDate + 'T00:00:00Z')) / (7 * DAY_MS)
    ) + 1;
  return w >= 1 && w <= (sem.totalWeeks ?? 99) ? w : null;
}

/* ================= 预览 chips ================= */

function renderChips() {
  const box = document.createDocumentFragment();
  box.append(el(`<div class="section-title">预览时间</div>`));
  const chips = el(`<div class="chips"></div>`);
  box.append(chips);
  const mk = (label, on, fn) => {
    const c = el(`<button class="chip ${on ? 'is-on' : ''}">${label}</button>`);
    c.onclick = fn;
    chips.append(c);
  };
  mk('实时', view.preview.live, () => {
    view.preview.live = true;
    paint();
  });
  for (let d = 0; d < spanDays(); d++) {
    mk(WD[wdOf(d)], !view.preview.live && view.preview.day === d, () => {
      view.preview = { live: false, day: d, minute: 19 * 60 };
      paint();
    });
  }
  return box;
}

/* ================= 左右滑动切页 ================= */
// 跟手拖动 + 松手判定。不做「双页同时渲染」——那要改渲染架构，代价远大于收益。
const TAB_ORDER = ['now', 'week', 'tasks', 'stats', 'settings'];

let swipe = null;

/** 这些地方不该触发切页：弹层、输入框、横向滚动的控件 */
function swipeBlocked(target) {
  if (!target || !target.closest) return true;
  if (document.querySelector('.sheet, .confirm')) return true;
  return !!target.closest('input, textarea, select, .sheet, .confirm, .chips, .theme-grid, .seg');
}

document.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1 || swipeBlocked(e.target)) {
      swipe = null;
      return;
    }
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, dy: 0, decided: false, active: false };
  },
  { passive: true }
);

document.addEventListener(
  'touchmove',
  (e) => {
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    swipe.dx = t.clientX - swipe.x;
    swipe.dy = t.clientY - swipe.y;

    if (!swipe.decided) {
      if (Math.abs(swipe.dx) < 10 && Math.abs(swipe.dy) < 10) return;
      swipe.decided = true;
      // 横向明显大于纵向才接管，否则把手势让给页面滚动
      swipe.active = Math.abs(swipe.dx) > Math.abs(swipe.dy) * 1.15;
      if (!swipe.active) {
        swipe = null;
        return;
      }
    }
    if (!swipe.active) return;

    e.preventDefault();
    const i = TAB_ORDER.indexOf(view.tab);
    const edge = (swipe.dx > 0 && i === 0) || (swipe.dx < 0 && i === TAB_ORDER.length - 1);
    const dx = edge ? swipe.dx * 0.28 : swipe.dx; // 到头了给点阻尼
    app.style.transition = 'none';
    app.style.transform = `translateX(${dx}px)`;
  },
  { passive: false }
);

document.addEventListener('touchend', () => {
  if (!swipe || !swipe.active) {
    swipe = null;
    return;
  }
  const dx = swipe.dx;
  const i = TAB_ORDER.indexOf(view.tab);
  const dir = dx < 0 ? 1 : -1;
  const next = TAB_ORDER[i + dir];
  const enough = Math.abs(dx) > Math.min(90, (app.offsetWidth || 360) * 0.22);
  swipe = null;

  if (!next || !enough) return springBack();
  slideTo(next, dir);
});

document.addEventListener('touchcancel', () => {
  if (swipe && swipe.active) springBack();
  swipe = null;
});

function springBack() {
  app.style.transition = 'transform .18s ease-out';
  app.style.transform = 'translateX(0)';
  setTimeout(() => {
    app.style.transition = '';
  }, 200);
}

/** dir: 1 = 往左滑（下一页），-1 = 往右滑（上一页） */
function slideTo(tab, dir) {
  const w = app.offsetWidth || window.innerWidth;
  app.style.transition = 'transform .2s cubic-bezier(.2,.7,.3,1)';
  app.style.transform = `translateX(${-dir * w}px)`;
  setTimeout(() => {
    view.tab = tab;
    paint();
    window.scrollTo({ top: 0 });
    app.style.transition = 'none';
    app.style.transform = `translateX(${dir * w}px)`;
    requestAnimationFrame(() => {
      app.style.transition = 'transform .2s cubic-bezier(.2,.7,.3,1)';
      app.style.transform = 'translateX(0)';
      setTimeout(() => {
        app.style.transition = '';
      }, 240);
    });
  }, 190);
}
/* ================= 主渲染 ================= */

const app = document.getElementById('app');

/** 存档损坏时顶部的红条：先保住现场，再让用户选 */
function renderRecoveryBar() {
  const bar = el(`<div class="banner" style="background:#b3261e;color:#fff;border-radius:12px;margin:10px 12px">
      <div style="font-weight:600;margin-bottom:6px">存档读不出来，已停止保存</div>
      <div style="font-size:13px;opacity:.9;margin-bottom:10px">
        没有覆盖原文件。可以先导出原始内容，或从备份恢复。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="ghost-btn" id="rec-export" style="flex:1">导出原始数据</button>
        <button class="ghost-btn" id="rec-backup" style="flex:1">从备份恢复</button>
        <button class="ghost-btn danger" id="rec-reset" style="flex:1">清空重来</button>
      </div>
    </div>`);

  bar.querySelector('#rec-export').onclick = () => {
    const text = (recoverInfo && recoverInfo.raw) || '';
    if (!text) {
      toast('没有可导出的原始内容');
      return;
    }
    exportText(`corrupt-${todayStr()}.json`, 'application/json', text);
  };

  bar.querySelector('#rec-backup').onclick = async () => {
    let bak = null;
    try {
      const rawBak = bridge && bridge.loadBackup ? bridge.loadBackup() : '';
      if (rawBak) bak = JSON.parse(rawBak);
    } catch (e) {
      bak = null;
    }
    if (!bak || !looksLikeStore(bak)) {
      toast('没有可用的备份');
      return;
    }
    if (!(await askConfirm({ title: '从备份恢复', text: `备份里有 ${bak.tasks.length} 件任务，会覆盖当前那份读不出来的存档。`, ok: '恢复' }))) return;
    store = bak;
    storageLocked = false;
    recoverInfo = null;
    try {
      if (bridge && bridge.discardPrimary) bridge.discardPrimary();
    } catch (e) {}
    writeStore();
    rebuild();
    paint();
    toast('已从备份恢复');
  };

  bar.querySelector('#rec-reset').onclick = async () => {
    if (!(await askConfirm({ title: '清空重来', text: '损坏的存档会被覆盖。如果还没导出原始数据，建议先导。', ok: '清空', danger: true }))) return;
    const fx = seed;
    const today = todayStr();
    store = {
      ...fx,
      startDate: today,
      tasks: fx.tasks.map((t) => ({ ...t, deadlineDate: addDays(today, t.deadlineDay ?? 0) })),
    };
    storageLocked = false;
    recoverInfo = null;
    writeStore();
    rebuild();
    paint();
    toast('已重置');
  };

  return bar;
}

function paint(opts = {}) {
  const keepY = opts.keep ? window.scrollY : 0;
  app.style.transform = '';
  app.textContent = '';
  formEl = null;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.tab === view.tab);
  });

  if (storageLocked) app.append(renderRecoveryBar());

  if (view.tab === 'now') {
    app.append(renderNow());
    app.append(renderPending());
  } else if (view.tab === 'week') {
    app.append(renderWeek());
  } else if (view.tab === 'tasks') {
    app.append(renderTasks());
    const add = el(`<button class="fab">＋ 新建任务</button>`);
    add.onclick = () => openForm(null);
    app.append(add);
  } else if (view.tab === 'stats') {
    app.append(renderStats());
  } else {
    app.append(renderSettings());
  }
  window.scrollTo({ top: keepY });
}

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => {
    view.tab = b.dataset.tab;
    paint();
  };
});

applyTheme();
applySkin();
rebuild();
paint();
if (recoveredFromBackup) toast('存档损坏，已从备份恢复');
if (storageLocked) toast('存档损坏，已停止保存');

// ---- 页面开着不动也要跟着时间走 ----
const busy = () => formEl || document.querySelector('.sheet');

// 30 秒刷一次界面，让倒计时和「下一段」跟上（不动数据）
// 唯一的例外：跨过零点就地滚动一次，不然「今天」可能迟到最多 5 分钟（下一次重排）
setInterval(() => {
  if (busy() || view.tab !== 'now') return;
  if (todayStr() !== store.startDate) rebuild();
  paint({ keep: true });
}, 30000);

// 5 分钟重排一次：跨过计划块边界时，过期段会进「待处理」
setInterval(() => {
  if (busy()) return;
  rebuild();
  paint({ keep: true });
}, 300000);

// 从后台切回来立刻校正一次
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !busy()) {
    rebuild();
    paint({ keep: true });
  }
});
