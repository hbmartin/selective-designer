import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type YamlRecord = Record<string, unknown>;

const asRecord = (value: unknown): YamlRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as YamlRecord)
    : undefined;

const workflow = asRecord(
  parse(
    fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/code-quality.yml'),
      'utf8'
    )
  )
);
const jobs = asRecord(workflow?.jobs) ?? {};
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
) as { scripts: Record<string, string> };

function readJobSteps(id: string) {
  const job = asRecord(jobs[id]);
  if (!job || !Array.isArray(job.steps)) {
    throw new Error(`Expected test workflow job "${id}" with steps.`);
  }

  return job.steps.flatMap((step) => {
    const record = asRecord(step);
    return record ? [record] : [];
  });
}

function findStep(steps: YamlRecord[], name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Expected workflow step "${name}".`);
  return step;
}

describe('test workflow gates', () => {
  it('runs the full ordinary suite with coverage and retains failure reports', () => {
    const steps = readJobSteps('coverage');
    expect(manifest.scripts['test:coverage']).toBe('vitest run --coverage');
    const commands = String(findStep(steps, 'Run tests').run)
      .trim()
      .split('\n');
    expect(commands).toContain(
      'pnpm test:coverage --reporter=default --reporter=junit --outputFile.junit=test-results/vitest/junit.xml'
    );
    expect(findStep(steps, 'Upload Vitest reports and coverage').if).toBe(
      'always()'
    );
  });

  it('runs dedicated PostgreSQL tests separately and retains failure reports', () => {
    const steps = readJobSteps('postgres-integration');
    expect(manifest.scripts['test:integration:postgres']).toBe(
      'vitest run --config vitest.postgres.config.ts'
    );
    const commands = String(
      findStep(steps, 'Run PostgreSQL integration tests').run
    )
      .trim()
      .split('\n');
    expect(commands).toContain(
      'pnpm test:integration:postgres -- --reporter=default --reporter=junit --outputFile.junit=test-results/vitest-postgres/junit.xml'
    );
    expect(
      findStep(steps, 'Upload PostgreSQL integration test report').if
    ).toBe('always()');
  });
});
