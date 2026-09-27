// Archives the leaderboard and event log so the next booth shift starts clean. Never deletes.
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.KIRU_DATA_DIR || './data';
const files = ['scores.json', 'events.jsonl'].filter((f) => fs.existsSync(path.join(dataDir, f)));

if (files.length === 0) {
  console.log('nothing to reset');
} else {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let archive = path.join(dataDir, `archive-${stamp}`);
  for (let n = 2; fs.existsSync(archive); n++) archive = path.join(dataDir, `archive-${stamp}-${n}`);
  fs.mkdirSync(archive, { recursive: true });
  for (const f of files) {
    const from = path.join(dataDir, f);
    const to = path.join(archive, f);
    fs.renameSync(from, to);
    console.log(`moved ${from} -> ${to}`);
  }
}
