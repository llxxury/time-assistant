// 命令行调试入口：node engine/cli.js data/week6.json [wImportance=0.45 ...]
// 渲染逻辑在 render.js，命令行只负责读文件、传参数、打印。

import fs from 'node:fs';
import { renderWeek } from './render.js';

const file = process.argv[2] || 'scheduler/data/week6.json';
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));

const override = {};
for (const a of process.argv.slice(3)) {
  const [k, v] = a.split('=');
  if (k && v !== undefined) override[k] = Number(v);
}

console.log(renderWeek(fixture, override));
