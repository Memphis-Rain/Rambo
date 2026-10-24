import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import YAML from 'yaml';
import { ROOT } from '../helpers/load-game.js';

// An invalid workflow file makes GitHub skip CI entirely (no job runs, so a CI step can't
// catch it). Parse every workflow here, in `npm test`, before anything is pushed.
const dir = path.join(ROOT, '.github', 'workflows');
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

describe('T9 CI workflows', () => {
  test('T9: workflow files exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`T9: ${f} is valid YAML with jobs that each have steps`, () => {
      const doc = YAML.parseDocument(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(doc.errors.map((e) => e.message), `${f}: YAML errors`).toEqual([]);
      const wf = doc.toJS();
      expect(wf.on, `${f}: triggers`).toBeTruthy();
      expect(Object.keys(wf.jobs || {}).length, `${f}: jobs`).toBeGreaterThan(0);
      for (const [name, job] of Object.entries(wf.jobs)) {
        expect(Array.isArray(job.steps) && job.steps.length > 0, `${f}: job ${name} has steps`).toBe(true);
        for (const step of job.steps) {
          expect(typeof (step.run ?? step.uses), `${f}: job ${name} step ${JSON.stringify(step.name)} runs something`).toBe('string');
        }
      }
    });
  }
});
