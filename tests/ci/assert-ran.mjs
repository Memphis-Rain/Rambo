// CI guard: fail when a Playwright run executed no tests (an empty shard, or a --grep
// that silently matches nothing or only skipped tests).
//   node tests/ci/assert-ran.mjs [test-results/results.json] [minimum=1]
import fs from 'node:fs';

const file = process.argv[2] || 'test-results/results.json';
const min = Number(process.argv[3] || 1);
if (!fs.existsSync(file)) {
  console.error(`assert-ran: ${file} not found (did the Playwright run start?)`);
  process.exit(1);
}
const { stats } = JSON.parse(fs.readFileSync(file, 'utf8'));
const ran = (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0);
console.log(`assert-ran: ${ran} executed (expected ${stats.expected}, unexpected ${stats.unexpected}, flaky ${stats.flaky}, skipped ${stats.skipped})`);
if (ran < min) {
  console.error(`assert-ran: expected at least ${min} executed test(s)`);
  process.exit(1);
}
