// The guard against a throwaway repository: each kind of leak is refused,
// the value is never printed, and the private patterns are required when
// asked for. The private patterns here are made-up stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, scanText, isFixturePath } from '../guard.mjs';

// Planted values are built at run time, so this file passes the guard itself.
const ACCOUNT = ['1234', '5678', '9012'].join('');
const HOST = ['db', 'internal', 'example'].join('.');

const PRIVATE = JSON.stringify({ deny: '(acmecorp-secret-tenant)', internal: '(\\bwidget-service\\b)', proprietaryPath: '(^|/)secret-rule[^/]*$' });

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - pkg\n');
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg/package.json'), JSON.stringify({ name: '@tensorcost/pkg', version: '1.0.0' }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function guard(root, argv = [], env = {}) {
  const lines = [];
  const code = run(argv, { root, env, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
}

test('a clean tree passes, and says when only the generic rules ran', () => {
  const r = guard(repo({ 'README.md': 'hello\n' }));
  assert.equal(r.code, 0);
  assert.match(r.out, /generic rules only/);
});

test('an account id, an internal host and a secret file are refused without printing them', () => {
  const r = guard(repo({ 'a.md': `account ${ACCOUNT} here\n`, 'b.md': `see ${HOST}\n`, '.env': 'X=1\n' }));
  assert.equal(r.code, 1);
  assert.match(r.out, /a\.md:1 {2}account-id/);
  assert.match(r.out, /b\.md:1 {2}internal-host/);
  assert.match(r.out, /\.env:0 {2}secret-file/);
  assert.ok(!r.out.includes(ACCOUNT) && !r.out.includes(HOST));
});

test('a 12-digit id is allowed in a recorded fixture, a private name is not', () => {
  assert.ok(isFixturePath('workato/fixtures/vcr_cassettes/x.json'));
  const patterns = { deny: /acmecorp-secret-tenant/i, internal: /\bwidget-service\b/i, proprietaryPath: /secret-rule/ };
  assert.deepEqual(scanText('w/fixtures/x.json', `"id": ${ACCOUNT}`), []);
  assert.equal(scanText('w/fixtures/x.json', 'acmecorp-secret-tenant', { privatePatterns: patterns })[0].rule, 'deny-pattern');
});

test('the private patterns catch a name, an internal service and a proprietary file', () => {
  const root = repo({ 'a.md': 'for acmecorp-secret-tenant\n', 'b.md': 'the widget-service does it\n', 'src/secret-rule.ts': 'x\n' });
  const r = guard(root, [], { TC_GUARD_PATTERNS: PRIVATE });
  assert.equal(r.code, 1);
  assert.match(r.out, /a\.md:1 {2}deny-pattern/);
  assert.match(r.out, /b\.md:1 {2}internal-name/);
  assert.match(r.out, /src\/secret-rule\.ts:0 {2}proprietary-path/);
  assert.doesNotMatch(r.out, /acmecorp|widget-service/);
});

test('without the private patterns, --require-private and TC_GUARD_REQUIRE_PRIVATE fail closed', () => {
  const root = repo({ 'README.md': 'hello\n' });
  assert.throws(() => guard(root, ['--require-private']), /private patterns are required/);
  assert.throws(() => guard(root, [], { TC_GUARD_REQUIRE_PRIVATE: 'true' }), /private patterns are required/);
  assert.equal(guard(root, ['--require-private'], { TC_GUARD_PATTERNS: PRIVATE }).code, 0);
});

test('a dependency on a @tensorcost package this repository does not publish is refused', () => {
  const root = repo({ 'other/package.json': JSON.stringify({ name: 'x', dependencies: { '@tensorcost/pkg': '1.0.0', '@tensorcost/not-public': '1.0.0' } }) });
  const r = guard(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /other\/package\.json:0 {2}private-dependency \(dependencies\)/);
  assert.equal(r.out.match(/private-dependency/g).length, 1);
});

test('an archive is checked as it will be published, symlinks included', () => {
  const root = repo({});
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-archive-'));
  fs.mkdirSync(path.join(stage, 'package'));
  fs.writeFileSync(path.join(stage, 'package/index.js'), `// ${ACCOUNT}\n`);
  fs.symlinkSync('/etc/hosts', path.join(stage, 'package/link'));
  const tgz = path.join(stage, 'p.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', stage, 'package']).status, 0);
  const r = guard(root, ['--archive', tgz]);
  assert.equal(r.code, 1);
  assert.match(r.out, /package\/index\.js:1 {2}account-id/);
  assert.match(r.out, /package\/link:0 {2}symlink/);
});

test('--gitleaks fails closed when gitleaks is not there, and finds a planted key when it is', () => {
  const root = repo({ 'README.md': 'hello\n' });
  assert.throws(() => run(['--gitleaks'], { root, env: { GITLEAKS: '/nonexistent/gitleaks' }, log: () => {} }), /gitleaks is required/);
  if (spawnSync('gitleaks', ['version']).status !== 0) return;
  const leaky = repo({ 'config.js': `const key = "AKIA${'Q'.repeat(4)}RSTUVWXYZ2345";\nconst secret = "${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}EXAMPLEKEY";\n` });
  const r = guard(leaky, ['--gitleaks']);
  assert.equal(r.code, 1);
  assert.match(r.out, /gitleaks/);
});
