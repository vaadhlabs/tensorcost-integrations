#!/usr/bin/env node
// Keeps what must not be published out of this repository and its packages.
//
//   node tools/guard.mjs                     the working tree (tracked and new files)
//   node tools/guard.mjs --pack <dir>        packs the package in <dir> and checks the tarball
//   node tools/guard.mjs --archive <file>    checks a .tgz, .tar.gz, .whl or .zip as it will be published
//
// Options:
//   --gitleaks         also run gitleaks over what is checked; fails if gitleaks isn't
//                      installed (GITLEAKS names the binary when it isn't on PATH)
//   --require-private  fail unless the private patterns are given (see below)
//
// Generic rules live here: 12-digit cloud account ids, .internal. host names,
// secret-looking files, and a dependency on a @tensorcost package this
// repository doesn't publish. Patterns that name what they guard against
// (a customer's name, an internal service) can't live in a public file, so
// they come from TC_GUARD_PATTERNS (JSON) or the file TC_GUARD_PATTERNS_FILE
// names: { "deny": "<regex>", "internal": "<regex>", "proprietaryPath": "<regex>" }.
// CI passes them from a repository secret. TC_GUARD_REQUIRE_PRIVATE=true
// works like --require-private.
//
// A finding prints the file, line and rule, never the matched text. Exit 0
// clean, 1 findings, 2 the guard itself couldn't run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 12-digit numbers are cloud account ids (AWS) until shown otherwise. */
export const ACCOUNT_ID = /(?<![\d.])\d{12}(?![\d.])/;
/** Internal host names. */
export const INTERNAL_HOST = /[a-z0-9-]\.internal\.[a-z]/i;
/** Files that hold keys or local configuration, never source. */
export const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.p12|.*\.pfx|id_rsa.*|.*\.key|master\.key|settings\.yaml\.enc|\.npmrc|\.pypirc)$/i;

/** Test fixtures carry recorded traffic: ids that look like account ids are allowed there, nothing else is. */
export function isFixturePath(rel) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => p === 'fixtures' || p === '__fixtures__' || p === 'cassettes')) return true;
  return /\.fixtures?\./.test(parts.at(-1));
}

/** The @tensorcost packages this repository publishes, read from the workspace. */
export function publicPackages(root = ROOT) {
  const ws = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const dirs = [...ws.matchAll(/^\s*-\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/['"]/g, ''));
  return new Set(dirs.map((d) => JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')).name));
}

export function loadPrivatePatterns(env = process.env) {
  let raw = env.TC_GUARD_PATTERNS?.trim();
  if (!raw && env.TC_GUARD_PATTERNS_FILE) raw = fs.readFileSync(env.TC_GUARD_PATTERNS_FILE, 'utf8');
  if (!raw) return null;
  const j = JSON.parse(raw);
  const out = {};
  for (const k of ['deny', 'internal', 'proprietaryPath']) {
    if (typeof j[k] !== 'string' || !j[k]) throw new Error(`private patterns: ${k} is missing`);
    out[k] = new RegExp(j[k], 'i');
  }
  return out;
}

/** Findings for one file's text. `rel` is its path as published. */
export function scanText(rel, text, { privatePatterns = null, publicNames = new Set() } = {}) {
  const findings = [];
  const add = (line, rule) => findings.push({ file: rel, line, rule });
  if (SECRET_FILE.test(rel)) add(0, 'secret-file');
  if (privatePatterns?.proprietaryPath.test(rel)) add(0, 'proprietary-path');
  const fixture = isFixturePath(rel);
  // latin1 keeps every byte and dropping NULs lets UTF-16 text match; \n survives, so line numbers do.
  const lines = text.replace(/\0/g, '').split('\n');
  lines.forEach((l, i) => {
    if (!fixture && ACCOUNT_ID.test(l)) add(i + 1, 'account-id');
    if (INTERNAL_HOST.test(l)) add(i + 1, 'internal-host');
    if (privatePatterns?.deny.test(l)) add(i + 1, 'deny-pattern');
    if (privatePatterns?.internal.test(l)) add(i + 1, 'internal-name');
  });
  if (path.posix.basename(rel) === 'package.json') {
    try {
      const p = JSON.parse(text);
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
        for (const dep of Object.keys(p[field] ?? {})) {
          if (dep.startsWith('@tensorcost/') && !publicNames.has(dep)) add(0, `private-dependency (${field})`);
        }
      }
    } catch {
      add(0, 'unreadable-package-json');
    }
  }
  return findings;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push({ rel: path.relative(base, p).split(path.sep).join('/'), abs: null, symlink: true });
    else if (e.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).split(path.sep).join('/'), abs: p });
  }
  return out;
}

function treeFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean).filter((rel) => fs.existsSync(path.join(root, rel))).map((rel) => ({ rel, abs: path.join(root, rel) }));
}

function extract(archive) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-guard-'));
  const isZip = /\.(whl|zip)$/i.test(archive);
  const r = isZip ? spawnSync('unzip', ['-q', archive, '-d', dest]) : spawnSync('tar', ['-xzf', archive, '-C', dest]);
  if (r.status !== 0) throw new Error(`could not unpack ${archive}`);
  return dest;
}

function pack(dir) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-guard-pack-'));
  // pnpm pack writes workspace: versions as the real ones, as publishing does.
  const r = spawnSync('pnpm', ['pack', '--pack-destination', dest], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pnpm pack failed in ${dir}: ${r.stderr || r.stdout}`);
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`pnpm pack wrote no tarball in ${dir}`);
  return path.join(dest, tgz);
}

function gitleaks(dir, env) {
  const bin = env.GITLEAKS || 'gitleaks';
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gitleaks-')), 'report.json');
  const r = spawnSync(bin, ['dir', '--no-banner', '--redact', '--report-format', 'json', '--report-path', report, dir], { encoding: 'utf8' });
  if (r.error) throw new Error(`gitleaks is required (--gitleaks) and couldn't start: ${r.error.message}`);
  if (r.status === 0) return [];
  if (r.status !== 1) throw new Error(`gitleaks failed with exit code ${r.status}: ${r.stderr}`);
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch {}
  if (!items.length) return [{ file: dir, line: 0, rule: 'gitleaks' }];
  return items.map((it) => ({ file: path.relative(dir, it.File ?? '') || it.File, line: it.StartLine ?? 0, rule: `gitleaks:${it.RuleID ?? 'finding'}` }));
}

export function run(argv, { env = process.env, log = console.log, root = ROOT } = {}) {
  let mode = 'tree';
  let target = root;
  let wantGitleaks = false;
  let requirePrivate = env.TC_GUARD_REQUIRE_PRIVATE === 'true';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack') [mode, target] = ['pack', path.resolve(argv[++i] ?? '.')];
    else if (a === '--archive') [mode, target] = ['archive', path.resolve(argv[++i] ?? '')];
    else if (a === '--gitleaks') wantGitleaks = true;
    else if (a === '--require-private') requirePrivate = true;
    else throw new Error(`unknown option ${a}`);
  }
  const privatePatterns = loadPrivatePatterns(env);
  if (requirePrivate && !privatePatterns) throw new Error('the private patterns are required here and TC_GUARD_PATTERNS is not set');
  const publicNames = publicPackages(root);

  let files;
  let scanned = target;
  let label = 'working tree';
  if (mode === 'tree') files = treeFiles(target);
  else {
    const archive = mode === 'pack' ? pack(target) : target;
    scanned = extract(archive);
    files = walk(scanned);
    label = path.basename(archive);
  }

  const findings = [];
  for (const f of files) {
    if (f.symlink) {
      findings.push({ file: f.rel, line: 0, rule: 'symlink' });
      continue;
    }
    findings.push(...scanText(f.rel, fs.readFileSync(f.abs).toString('latin1'), { privatePatterns, publicNames }));
  }
  if (wantGitleaks) findings.push(...gitleaks(scanned, env));

  const scope = privatePatterns ? 'generic and private rules' : 'generic rules only (no private patterns given)';
  if (findings.length) {
    log(`guard: ${label}: ${findings.length} finding(s), ${scope}. Values are not printed.`);
    for (const f of findings) log(`  ${f.file}:${f.line}  ${f.rule}`);
    return 1;
  }
  log(`guard: ${label}: ${files.length} file(s) clean, ${scope}${wantGitleaks ? ', gitleaks' : ''}.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`guard: ${err.message}`);
    process.exitCode = 2;
  }
}
