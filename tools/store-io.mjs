/**
 * 存档备份 / 恢复（二进制安全）。
 *
 * 为什么不用 PowerShell 管道：PS 5.1 会用 ANSI 解码 node 输出的 UTF-8 字节，
 * 中文会被二次编码成 é•¿æœŸé¡¹ç›® 这种乱码，再写回就是脏数据。
 * 这里用 execFileSync 拿 Buffer，原样落盘。
 *
 * 用法:
 *   node tools/store-io.mjs dump  backup.json
 *   node tools/store-io.mjs restore backup.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CDP = path.join(here, 'cdp.mjs');

const [mode, file] = process.argv.slice(2);
if (!mode || !file) {
  console.error('用法: node tools/store-io.mjs dump|restore <file>');
  process.exit(2);
}

function evalInPage(expr) {
  // 拿 Buffer，不解码，避免任何字符集转换
  return execFileSync(process.execPath, [CDP, expr], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

if (mode === 'dump') {
  const buf = evalInPage('Cosmos.load()');
  // cdp 输出是一段 JSON 字符串，校验一下再写
  const text = buf.toString('utf8').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('拿到的不是合法 JSON，前 80 字节: ' + text.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(parsed), 'utf8');
  const tasks = (JSON.parse(JSON.stringify(parsed)).tasks || []).length;
  console.log(`已备份 -> ${file}（${Buffer.byteLength(JSON.stringify(parsed))} 字节，${tasks} 件任务）`);
} else if (mode === 'restore') {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('备份文件不是合法 JSON');
    process.exit(1);
  }
  // 注意：atob 给的是「每字符=1字节」的二进制串，直接喂给 Java 桥会被当 UTF-8 重新编码，
  // 中文就变成 é•¿æœŸé¡¹ç›®。必须先用 TextDecoder 按 UTF-8 解出来。
  const b64 = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');
  const out = evalInPage(
    `(()=>{` +
      `const bin=atob('${b64}');` +
      `const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));` +
      `const raw=new TextDecoder('utf-8').decode(bytes);` +
      `return Cosmos.save(raw)?'ok':'fail';})()`
  ).toString('utf8');
  if (!/ok/.test(out)) {
    console.error('写回失败: ' + out);
    process.exit(1);
  }
  console.log(`已恢复 <- ${file}`);
} else {
  console.error('未知模式: ' + mode);
  process.exit(2);
}
