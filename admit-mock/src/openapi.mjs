// Reads the admit protocol's OpenAPI file and checks values against its
// schemas, with nothing but Node. The mock uses it to check every request it
// gets and every answer it gives; the conformance cases use it the same way.
//
// The YAML reader covers what the admit OpenAPI file uses (block mappings and
// sequences, one-line flow collections, quoted and plain scalars, folded and
// literal block scalars) and throws on anything else, so a construct it
// doesn't know fails loudly instead of reading as something it isn't. The
// schema check covers the JSON Schema keywords the file uses and throws on
// any other keyword, for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the OpenAPI file sits: TENSORCOST_ADMIT_OPENAPI if set, then
 * spec/admit/openapi.yaml in the integrations repository, then the
 * TensorCost monorepo's source of the same file. Null when none exists.
 */
export function findSpec(env = process.env) {
  const candidates = [
    env.TENSORCOST_ADMIT_OPENAPI,
    path.resolve(HERE, '../../spec/admit/openapi.yaml'),
    path.resolve(HERE, '../../../packages/contracts/specs/gateway-admit.openapi.yaml'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function loadSpec(file = findSpec()) {
  if (!file) throw new Error('admit OpenAPI file not found; set TENSORCOST_ADMIT_OPENAPI');
  return parseYaml(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- YAML

class YamlError extends Error {}

function fail(lineNo, why) {
  throw new YamlError(`yaml line ${lineNo}: ${why}`);
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

export function parseYaml(source) {
  const raw = source.replace(/\r\n/g, '\n').split('\n');
  const lines = raw.map((text, i) => ({ no: i + 1, raw: text }));
  let pos = 0;

  const indentOf = (s) => s.length - s.trimStart().length;
  const isBlank = (s) => stripComment(s).trim() === '';

  function skipBlank() {
    while (pos < lines.length && isBlank(lines[pos].raw)) pos++;
  }

  function peek() {
    skipBlank();
    if (pos >= lines.length) return null;
    const { raw: r, no } = lines[pos];
    if (r.includes('\t') && /^\s*\t/.test(r)) fail(no, 'tab indentation');
    if (/^(---|\.\.\.)\s*$/.test(r)) fail(no, 'multiple documents');
    return { indent: indentOf(r), text: stripComment(r).trim(), no };
  }

  function parseNode(minIndent) {
    const next = peek();
    if (!next || next.indent < minIndent) return null;
    if (next.text === '-' || next.text.startsWith('- ')) return parseSeq(next.indent);
    return parseMap(next.indent);
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const next = peek();
      if (!next || next.indent < indent) break;
      if (next.indent > indent) fail(next.no, 'unexpected indentation in a sequence');
      if (!(next.text === '-' || next.text.startsWith('- '))) break;
      const rest = next.text.slice(1).trimStart();
      if (rest === '') {
        pos++;
        out.push(parseNode(indent + 1));
      } else if (keyOf(rest)) {
        // "- key: value": a mapping whose first key sits after the dash. The
        // line is rewritten as that key at its own column, where the
        // mapping's other keys sit too.
        const col = next.indent + (next.text.length - rest.length);
        lines[pos] = { no: next.no, raw: ' '.repeat(col) + rest };
        out.push(parseMap(col));
      } else {
        pos++;
        out.push(scalarOrFlow(rest, next.no, indent));
      }
    }
    return out;
  }

  function keyOf(text) {
    let m = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+(.*)|$)/.exec(text);
    if (m) return { key: JSON.parse(`"${m[1]}"`), rest: m[2] ?? '' };
    m = /^'((?:[^']|'')*)'\s*:(?:\s+(.*)|$)/.exec(text);
    if (m) return { key: m[1].replace(/''/g, "'"), rest: m[2] ?? '' };
    m = /^([^\s"'{[\]},#&*!|>%@`-][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+(.*)|$)/.exec(text);
    if (m) return { key: m[1], rest: m[2] ?? '' };
    return null;
  }

  function parseMap(indent) {
    const out = {};
    for (;;) {
      const next = peek();
      if (!next || next.indent < indent) break;
      if (next.indent > indent) fail(next.no, 'unexpected indentation in a mapping');
      if (next.text === '-' || next.text.startsWith('- ')) break;
      const kv = keyOf(next.text);
      if (!kv) fail(next.no, `expected "key: value", got ${JSON.stringify(next.text)}`);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) fail(next.no, `duplicate key ${kv.key}`);
      pos++;
      const rest = kv.rest.trim();
      if (rest === '') {
        const child = peek();
        // A sequence may sit at its key's own indentation.
        if (child && child.indent === indent && (child.text === '-' || child.text.startsWith('- '))) out[kv.key] = parseSeq(indent);
        else out[kv.key] = parseNode(indent + 1);
      } else if (/^[>|][-+]?$/.test(rest)) {
        out[kv.key] = blockScalar(rest, indent, next.no);
      } else {
        out[kv.key] = scalarOrFlow(rest, next.no, indent);
      }
    }
    return out;
  }

  function blockScalar(header, parentIndent, no) {
    const folded = header[0] === '>';
    const chomp = header[1] ?? '';
    if (chomp === '+') fail(no, 'keep chomping (+) is not supported');
    const body = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const r = lines[pos].raw;
      if (r.trim() === '') {
        body.push(null);
        pos++;
        continue;
      }
      const ind = indentOf(r);
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) fail(lines[pos].no, 'block scalar line indented less than its first line');
      body.push(r.slice(blockIndent));
      pos++;
    }
    while (body.length && body[body.length - 1] === null) body.pop();
    let text = '';
    if (!folded) {
      text = body.map((l) => l ?? '').join('\n');
    } else {
      let prev = null; // 'text' | 'more' (more-indented), after the last text line
      let blanks = 0;
      for (const l of body) {
        if (l === null) {
          blanks++;
          continue;
        }
        const kind = /^\s/.test(l) ? 'more' : 'text';
        if (prev === null) text += '\n'.repeat(blanks);
        else if (prev === 'text' && kind === 'text') text += blanks ? '\n'.repeat(blanks) : ' ';
        else text += '\n'.repeat(blanks + 1);
        text += l;
        prev = kind;
        blanks = 0;
      }
    }
    return chomp === '-' ? text : text === '' ? '' : `${text}\n`;
  }

  function scalarOrFlow(text, no, indent) {
    // A scalar or flow collection continued on a deeper line is not supported.
    const after = peek();
    if (after && after.indent > indent) fail(after.no, 'multi-line scalars and flow collections are not supported');
    if (text.startsWith('{') || text.startsWith('[')) {
      const p = { s: text, i: 0, no };
      const v = flowValue(p);
      skipWs(p);
      if (p.i !== p.s.length) fail(no, 'text after a flow collection');
      return v;
    }
    return scalar(text, no);
  }

  return parseNode(0);
}

function skipWs(p) {
  while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
}

function flowValue(p) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '{') {
    p.i++;
    const out = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === '}') {
        p.i++;
        return out;
      }
      const key = flowScalarText(p, ':');
      if (p.s[p.i] !== ':') fail(p.no, 'expected ":" in a flow mapping');
      p.i++;
      const value = flowValue(p);
      out[typeof key === 'string' ? key : String(key)] = value;
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== '}') fail(p.no, 'expected "," or "}"');
    }
  }
  if (c === '[') {
    p.i++;
    const out = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === ']') {
        p.i++;
        return out;
      }
      out.push(flowValue(p));
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== ']') fail(p.no, 'expected "," or "]"');
    }
  }
  return flowScalarText(p, null);
}

// A scalar inside a flow collection: quoted, or plain up to , } ] (and : when reading a key).
function flowScalarText(p, stopAtColon) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '"' || c === "'") {
    const start = p.i;
    p.i++;
    while (p.i < p.s.length && p.s[p.i] !== c) {
      if (c === '"' && p.s[p.i] === '\\') p.i++;
      else if (c === "'" && p.s[p.i] === "'" && p.s[p.i + 1] === "'") p.i++;
      p.i++;
    }
    if (p.i >= p.s.length) fail(p.no, 'unterminated quoted scalar');
    p.i++;
    return scalar(p.s.slice(start, p.i), p.no);
  }
  const start = p.i;
  while (p.i < p.s.length) {
    const ch = p.s[p.i];
    if (ch === ',' || ch === '}' || ch === ']') break;
    if (ch === '{' || ch === '[') fail(p.no, 'a flow collection inside a plain scalar');
    // ": " ends a key; a colon inside a value (a URL, "a:b") does not.
    if (ch === ':' && stopAtColon && /[\s,}\]]/.test(p.s[p.i + 1] ?? ' ')) break;
    p.i++;
  }
  const text = p.s.slice(start, p.i).trim();
  if (text === '') fail(p.no, 'empty value in a flow collection');
  return scalar(text, p.no);
}

function scalar(text, no) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) fail(no, 'unterminated double-quoted scalar');
    try {
      return JSON.parse(text);
    } catch {
      fail(no, 'a double-quoted escape JSON does not read');
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) fail(no, 'unterminated single-quoted scalar');
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>%@`]/.test(text)) fail(no, `unsupported YAML construct ${JSON.stringify(text)}`);
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(text)) fail(no, `unsupported number ${text}`);
  return text;
}

// ---------------------------------------------------------- schemas

const ANNOTATIONS = new Set(['description', 'title', 'example', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const got = typeOf(v);
  return got === want || (want === 'number' && got === 'integer');
}

function resolveRef(spec, ref) {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref is supported: ${ref}`);
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`$ref ${ref} names nothing`);
  }
  return node;
}

/**
 * The problems with `value` against `schema`, as "path: what" strings.
 * Empty means it validates. `strict` also names object properties the
 * schema doesn't list, which the schemas allow but a mock shouldn't send.
 */
export function validate(spec, schema, value, { strict = false, at = '$' } = {}) {
  const errors = [];
  const walk = (s, v, where) => {
    if (s.$ref) {
      const others = Object.keys(s).filter((k) => k !== '$ref' && !ANNOTATIONS.has(k));
      if (others.length) throw new Error(`${where}: $ref beside ${others.join(', ')} is not supported`);
      walk(resolveRef(spec, s.$ref), v, where);
      return;
    }
    for (const k of Object.keys(s)) {
      if (ANNOTATIONS.has(k) || k.startsWith('x-')) continue;
      if (!['type', 'enum', 'required', 'properties', 'items', 'maxItems', 'minItems', 'minimum', 'maximum', 'maxLength', 'minLength', 'format'].includes(k)) {
        throw new Error(`schema keyword "${k}" at ${where} is not supported`);
      }
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) {
        errors.push(`${where}: is ${typeOf(v)}, wants ${types.join(' or ')}`);
        return;
      }
    }
    if (s.enum && !s.enum.some((e) => e === v)) errors.push(`${where}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
    if (typeof v === 'string') {
      if (s.maxLength !== undefined && [...v].length > s.maxLength) errors.push(`${where}: longer than ${s.maxLength}`);
      if (s.minLength !== undefined && [...v].length < s.minLength) errors.push(`${where}: shorter than ${s.minLength}`);
      if (s.format === 'uuid' && !UUID.test(v)) errors.push(`${where}: not a uuid`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${where}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${where}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${where}: more than ${s.maxItems} items`);
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${where}: fewer than ${s.minItems} items`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, `${where}[${i}]`));
    }
    if (typeOf(v) === 'object') {
      for (const r of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(v, r)) errors.push(`${where}: missing ${r}`);
      }
      const props = s.properties ?? {};
      for (const [k, item] of Object.entries(v)) {
        if (props[k]) walk(props[k], item, `${where}.${k}`);
        else if (strict && s.properties) errors.push(`${where}: ${k} is not in the schema`);
      }
    }
  };
  walk(schema, value, at);
  return errors;
}

/** The schema for an operation's JSON request body or a response status, by operationId. */
export function operationSchemas(spec, operationId) {
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op?.operationId !== operationId) continue;
      const json = (c) => c?.content?.['application/json']?.schema ?? null;
      const responses = Object.fromEntries(Object.entries(op.responses ?? {}).map(([status, r]) => [status, json(r)]));
      return { route, method, request: json(op.requestBody), responses, headers: op.responses?.['200']?.headers ?? {} };
    }
  }
  throw new Error(`operation ${operationId} not in the OpenAPI file`);
}
