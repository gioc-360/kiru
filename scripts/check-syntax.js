// Syntax gate: `node --check` every JavaScript file we ship or test with.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server.js', 'public', 'scripts', 'test', 'test-e2e'];
const files = [];
function walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) if (f !== 'node_modules' && f !== 'out') walk(path.join(p, f));
  } else if (p.endsWith('.js')) files.push(p);
}
roots.forEach(walk);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${e.stderr}`);
  }
}
console.log(`syntax: ${files.length - failed}/${files.length} files ok`);
process.exit(failed ? 1 : 0);
