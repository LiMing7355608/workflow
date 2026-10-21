// 把静态资源复制到 dist，让 dist/ 自包含（交作业打包时不依赖 src 目录）。
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('src/web/public');
const dst = path.resolve('dist/web/public');

fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });

const count = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1),
    0,
  );

console.log(`copied ${count(dst)} files → dist/web/public`);
