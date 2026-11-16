// A strict, small XML reader for the bundle tests: elements, attributes,
// text, comments and the XML declaration. Anything not well-formed throws
// (an unclosed or crossed tag, a bare "&", a "<" in an attribute).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s, where) {
  return s.replace(/&([^;]*);?/g, (m, name) => {
    if (!m.endsWith(';') || !(name in ENTITIES)) throw new Error(`bare & in ${where}: ${m.slice(0, 20)}`);
    return ENTITIES[name];
  });
}

export function parseXml(xml) {
  let body = xml.replace(/^﻿/, '');
  const decl = /^<\?xml[^?]*\?>/.exec(body);
  if (decl) body = body.slice(decl[0].length);
  else if (body.startsWith('<?')) throw new Error('a processing instruction that is not the XML declaration');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token = /<!--([\s\S]*?)-->|<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  let last = 0;
  while ((m = token.exec(body))) {
    if (m.index !== last) throw new Error(`unreadable XML at ${last}`);
    last = token.lastIndex;
    const [, comment, close, name, attrs, selfClose, text, stray] = m;
    if (comment !== undefined) {
      if (comment.includes('--')) throw new Error('"--" inside a comment');
      continue;
    }
    if (stray) throw new Error(`stray < at ${m.index}: ${body.slice(m.index, m.index + 40)}`);
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (top === root) {
        if (text.trim() !== '') throw new Error('text outside the root element');
      } else top.text += decode(text, `<${top.name}>`);
      continue;
    }
    if (close) {
      const open = stack.pop();
      if (!open || open === root || open.name !== name) throw new Error(`</${name}> closes <${open?.name}>`);
      continue;
    }
    const el = { name, attrs: {}, children: [], text: '' };
    for (const a of attrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (a[1] in el.attrs) throw new Error(`attribute ${a[1]} twice on <${name}>`);
      el.attrs[a[1]] = decode(a[2] ?? a[3], `${name}@${a[1]}`);
    }
    if (top === root && root.children.length > 0) throw new Error('more than one root element');
    top.children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (last !== body.length) throw new Error('unreadable XML at the end');
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is never closed`);
  if (root.children.length !== 1) throw new Error('no root element');
  return root.children[0];
}

/** The first child element with this name, or undefined. */
export const child = (el, name) => el.children.find((c) => c.name === name);
export const children = (el, name) => el.children.filter((c) => c.name === name);
/** The trimmed text of a path of child names, or undefined. */
export function textAt(el, ...names) {
  let at = el;
  for (const n of names) {
    at = at && child(at, n);
  }
  return at ? at.text.trim() : undefined;
}
