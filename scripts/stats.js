// After an event: did the booth work? Reads data/events.jsonl and answers the
// booth's success test: at least 15 finished rounds
// per two-hour shift, and no more than a quarter of started rounds abandoned.
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.KIRU_DATA_DIR || './data';
const file = path.join(dataDir, 'events.jsonl');
if (!fs.existsSync(file)) {
  console.log(`No events yet (${file} does not exist).`);
  process.exit(0);
}

const events = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const count = (e) => events.filter((x) => x.event === e).length;
const starts = count('start');
const ends = count('end');
const abandons = count('abandon') + count('reject');
const first = events[0]?.ts;
const last = events.at(-1)?.ts;
const hours = first && last ? Math.max((Date.parse(last) - Date.parse(first)) / 3.6e6, 1 / 60) : 0;
const scores = events.filter((e) => e.event === 'end').map((e) => e.score);
const players = new Set(events.filter((e) => e.event === 'end').map((e) => e.name.toLowerCase()));
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

console.log(`Events from ${first} to ${last} (${hours.toFixed(1)} h)`);
console.log(`  join events       ${count('join')}  (one per page load and one per PLAY tap)`);
console.log(`  rounds started    ${starts}`);
console.log(`  rounds finished   ${ends}  (${(ends / Math.max(hours, 1e-9)).toFixed(1)} per hour, ${players.size} unique names)`);
console.log(`  rounds abandoned  ${abandons}  (${pct(abandons, starts)} of started)`);
if (scores.length) {
  const sorted = [...scores].sort((a, b) => a - b);
  console.log(`  scores            median ${sorted[Math.floor(sorted.length / 2)]}, best ${sorted.at(-1)}`);
}
const perShift = (ends / Math.max(hours, 1e-9)) * 2;
const verdict = hours < 0.5 ? 'too little data for a verdict' : perShift >= 15 && abandons <= starts / 4 ? 'the bet held' : 'the bet failed';
console.log(`Falsifier (≥15 finished per 2 h, ≤25% abandoned): ${verdict}`);
