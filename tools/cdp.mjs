// 零依赖 CDP 客户端：往手机 App 的 WebView 里塞一段 JS 并取回结果。
// 前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
// 用法：node cdp.mjs "<js 表达式>"   （表达式里可以用 await，也可以用 window.Cosmos）
import process from 'node:process';
import fs from 'node:fs';

let expr = process.argv[2];
if (!expr) {
  console.error('用法: node cdp.mjs "<js 表达式>"  或  node cdp.mjs @脚本文件');
  process.exit(2);
}
// @file：表达式太长（比如整份存档 JSON）时，从文件读，避开命令行长度和引号转义
if (expr.startsWith('@')) expr = fs.readFileSync(expr.slice(1), 'utf8');

const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page') || list[0];
if (!page) {
  console.error('没找到 page target，json 是：', JSON.stringify(list, null, 1));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => {
  ws.onopen = ok;
  ws.onerror = bad;
});

// -y：自动点「确定」关掉 JS 的 confirm/alert（WebView 里它们会阻塞脚本，测试时要放行）
const autoAccept = process.argv.includes('-y');
if (autoAccept) ws.send(JSON.stringify({ id: 0, method: 'Page.enable' }));

const reply = await new Promise((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: 99, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (m.id === 1) resolve(m);
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
    })
  );
});

ws.close();

const r = reply.result || {};
if (r.exceptionDetails) {
  console.error('页面里抛异常：', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  process.exit(3);
}
const v = r.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
