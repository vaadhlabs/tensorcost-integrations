// The part of Apigee's condition language the shared flows use:
//   variable = "literal", variable != "literal", and, or, not, parentheses.
// A variable that isn't set is null: null = "x" is false, null != "x" is true.
// Anything else throws, so a condition the flows start using that this
// evaluator doesn't know fails the tests instead of passing them.

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\()|(\))|(!=|=)|"([^"]*)"|([A-Za-z_][\w.-]*))/y;
  let at = 0;
  while (at < src.length) {
    if (/^\s*$/.test(src.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) throw new Error(`can't read condition at ${at}: ${src}`);
    at = re.lastIndex;
    if (m[1]) out.push({ t: '(' });
    else if (m[2]) out.push({ t: ')' });
    else if (m[3]) out.push({ t: 'op', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'str', v: m[4] });
    else {
      const w = m[5];
      const lower = w.toLowerCase();
      if (lower === 'and' || lower === 'or' || lower === 'not') out.push({ t: lower });
      else if (lower === 'null') out.push({ t: 'null' });
      else out.push({ t: 'var', v: w });
    }
  }
  return out;
}

export function evaluate(src, vars) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = (t) => {
    const k = toks[i];
    if (!k || k.t !== t) throw new Error(`expected ${t} in ${src}`);
    i++;
    return k;
  };
  const operand = () => {
    const k = toks[i++];
    if (!k) throw new Error(`condition ends early: ${src}`);
    if (k.t === 'str') return k.v;
    if (k.t === 'null') return null;
    if (k.t === 'var') {
      const v = vars[k.v];
      return v === undefined || v === null ? null : String(v);
    }
    throw new Error(`not an operand in ${src}`);
  };
  const factor = () => {
    const k = peek();
    if (k?.t === 'not') {
      i++;
      return !factor();
    }
    if (k?.t === '(') {
      i++;
      const v = expr();
      take(')');
      return v;
    }
    const left = operand();
    const op = take('op').v;
    const right = operand();
    return op === '=' ? left === right : left !== right;
  };
  const term = () => {
    let v = factor();
    while (peek()?.t === 'and') {
      i++;
      v = factor() && v;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    while (peek()?.t === 'or') {
      i++;
      v = term() || v;
    }
    return v;
  };
  const v = expr();
  if (i !== toks.length) throw new Error(`unread tokens in ${src}`);
  return v;
}
