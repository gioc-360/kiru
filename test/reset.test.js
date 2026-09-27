import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/reset-scores.js', import.meta.url));
const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiru-reset-'));
  dirs.push(d);
  return d;
}

const run = (env, cwd) =>
  execFileSync(process.execPath, [script], { env: { ...process.env, ...env }, cwd, encoding: 'utf8' });

test('moves scores and events into a timestamped archive, never deleting', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'scores.json'), '[{"name":"Aiko","score":120,"ts":"2026-09-26T18:00:00.000Z"}]');
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '{"ts":"2026-09-26T18:00:00.000Z","event":"join"}\n');
  const out = run({ KIRU_DATA_DIR: dataDir }).trim().split('\n');

  assert.equal(out.length, 2);
  for (const line of out) assert.match(line, /^moved .+ -> .+archive-\d{8}-\d{6}\/(scores\.json|events\.jsonl)$/);
  assert.equal(fs.existsSync(path.join(dataDir, 'scores.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'events.jsonl')), false);
  const [archive] = fs.readdirSync(dataDir).filter((f) => f.startsWith('archive-'));
  assert.match(fs.readFileSync(path.join(dataDir, archive, 'scores.json'), 'utf8'), /Aiko/);
  assert.match(fs.readFileSync(path.join(dataDir, archive, 'events.jsonl'), 'utf8'), /"join"/);
});

test('moves only the files that exist', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  const out = run({ KIRU_DATA_DIR: dataDir }).trim().split('\n');
  assert.equal(out.length, 1);
  assert.match(out[0], /events\.jsonl$/);
});

test('a second reset in the same second does not overwrite the first archive', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'scores.json'), '["first"]');
  run({ KIRU_DATA_DIR: dataDir });
  fs.writeFileSync(path.join(dataDir, 'scores.json'), '["second"]');
  run({ KIRU_DATA_DIR: dataDir });
  const archives = fs.readdirSync(dataDir).filter((f) => f.startsWith('archive-'));
  assert.equal(archives.length, 2);
  const kept = archives.map((a) => fs.readFileSync(path.join(dataDir, a, 'scores.json'), 'utf8')).sort();
  assert.deepEqual(kept, ['["first"]', '["second"]']);
});

test('prints "nothing to reset" when there is nothing to move', () => {
  assert.equal(run({ KIRU_DATA_DIR: tmp() }), 'nothing to reset\n');
});

test('defaults to ./data and prints relative paths', () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'data'));
  fs.writeFileSync(path.join(cwd, 'data', 'scores.json'), '[]');
  const env = { ...process.env };
  delete env.KIRU_DATA_DIR;
  const out = execFileSync(process.execPath, [script], { env, cwd, encoding: 'utf8' });
  assert.match(out, /^moved data\/scores\.json -> data\/archive-\d{8}-\d{6}\/scores\.json\n$/);
});
