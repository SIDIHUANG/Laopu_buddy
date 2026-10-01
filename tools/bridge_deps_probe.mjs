// 桥接依赖解析检查（不 spawn 子进程，所以在受限沙箱里也能跑）。
//
// 为什么需要它：v1\ 包曾经只带了 tools\pet_bridge.mjs，而它会
// `import ... from '../app/src/adapters/codex.js'` —— 拷走之后桥接直接
// ERR_MODULE_NOT_FOUND，桌宠表现为"永远 idle、零事件"。这个探针就是
// 把"包内那一小撮 js 能不能全部解析、导出的东西在不在"变成机器可判定的。
//
// 用法：node tools/bridge_deps_probe.mjs [包根目录，默认 v1]
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgRoot = resolve(process.cwd(), process.argv[2] || join(root, 'v1'));

const bridgePath = join(pkgRoot, 'tools', 'pet_bridge.mjs');
if (!existsSync(bridgePath)) {
  console.error(`[deps] 找不到 ${bridgePath}`);
  process.exit(1);
}

// pet_bridge.mjs 直接 import 的模块 + 它们的期望导出
const REQUIRED = [
  { rel: 'app/src/adapters/codex.js', exports: ['normalizeCodex', 'newCodexContext', 'AGENT'] },
  { rel: 'app/src/lines.js', exports: ['CATEGORIES'] },
];
// 这两个是被适配器间接 import 的（protocol 被 codex/dsh 依赖）
const INDIRECT = [
  'app/src/protocol.js',
  'app/src/adapters/dsh.js',
  'app/src/usage-view.js',
];

const problems = [];
const load = async (rel, expect = []) => {
  const p = join(pkgRoot, rel);
  if (!existsSync(p)) { problems.push(`缺文件: ${rel}`); return; }
  try {
    const mod = await import(pathToFileURL(p).href);
    for (const name of expect) {
      if (!(name in mod)) problems.push(`${rel} 没有导出 ${name}`);
    }
    console.log(`  ok  ${rel}${expect.length ? `  (导出 ${expect.join(', ')})` : ''}`);
  } catch (e) {
    problems.push(`${rel} 导入失败: ${e.message}`);
  }
};

console.log(`[deps] 包根: ${pkgRoot}`);
console.log('[deps] 直接依赖：');
for (const r of REQUIRED) await load(r.rel, r.exports);
console.log('[deps] 间接依赖：');
for (const rel of INDIRECT) await load(rel);

if (problems.length) {
  console.log('[deps] 失败：');
  problems.forEach((p) => console.log(`   - ${p}`));
  process.exitCode = 1;
} else {
  console.log('[deps] 通过：包内桥接依赖齐全且都能 import');
}
