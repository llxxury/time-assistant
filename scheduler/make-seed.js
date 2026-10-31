// 把 app-seed.json 转成 ES 模块，file:// 下也能加载
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(new URL('./data/app-seed.json', import.meta.url), 'utf8'));
fs.writeFileSync(new URL('./data/seed.js', import.meta.url),
  '// 自动生成，别手改；改 data/app-seed.json 后跑 node make-seed.js\nexport default ' + JSON.stringify(j, null, 2) + ';\n');
console.log('seed.js 已更新');
