// CI helper: one GitHub annotation per failed E2E test, from Playwright's
// JSON report, with the first lines of its last error. GitHub keeps only 10
// annotations per step, and the reporter's own (one per retry) run out fast.
//   node scripts/e2e-failures.mjs e2e-results.json
import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync(process.argv[2] || 'e2e-results.json', 'utf8'));
const failures = [];
const walk = (suite, titles) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const last = test.results?.[test.results.length - 1];
      if (!last || ['passed', 'skipped'].includes(last.status) || test.status === 'expected' || test.status === 'flaky') continue;
      const error = (last.errors?.[0]?.message ?? last.error?.message ?? last.status ?? '').replace(/\u001b\[[0-9;]*m/g, '');
      failures.push({ file: spec.file, line: spec.line, title: [...titles, spec.title].filter(Boolean).join(' › '), error });
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
};
for (const suite of report.suites ?? []) walk(suite, []);

const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (const f of failures.slice(0, 10)) {
  const message = f.error.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n');
  console.log(`::error file=tests/e2e/${f.file},line=${f.line},title=${escape(f.title)}::${escape(message)}`);
}
console.log(`${failures.length} failed test(s).`);
