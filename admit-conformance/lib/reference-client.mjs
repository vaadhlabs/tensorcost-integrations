// A minimal admit client that follows spec/admit/README.md, as a
// conformance adapter. It is the cases' own check that they can be passed,
// and a short example of the rules in code. It is not a gateway plugin.

const NEVER_BILLED = new Set([401, 403, 404, 429]);

/**
 * `faults` breaks one rule on purpose, so the cases can be shown to catch
 * it: statusOnly (a 200 is an allow, whatever the body says), retryAdmit
 * (asks again after a timeout or error), cacheAll (reuses every allow for 5
 * seconds), cancelAll (cancels after any failure), adoptUnknownMode (takes
 * fail_mode from an answer that says it wasn't the workspace's).
 */
export function referenceAdapter({ canReroute = true, faults = {} } = {}) {
  return {
    capabilities: canReroute ? ['reroute', 'cancel'] : ['no_reroute', 'cancel'],
    async start({ url, key, fail_mode: configured, timeout_ms: timeoutMs, models }) {
      let learned = null;
      const cache = new Map();
      let last = null;

      async function admit(body) {
        const answer = await admitOnce(body);
        return answer === null && faults.retryAdmit ? admitOnce(body) : answer;
      }

      async function admitOnce(body) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          // One attempt: a resent admit would hold the call's reservation twice.
          const res = await fetch(`${url}/v1/gateway/admit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (res.status !== 200) return null;
          const answer = await res.json().catch(() => null);
          if (faults.statusOnly) return { decision: 'allow', decision_id: answer?.decision_id, cache_ttl_seconds: 0 };
          if (!answer || !['allow', 'refuse', 'reroute'].includes(answer.decision)) return null;
          // Never adopt a fail mode the answer says was the default's.
          if (answer.fail_mode_known !== false || faults.adoptUnknownMode) {
            const mode = res.headers.get('x-tc-fail-mode') ?? answer.fail_mode;
            if (mode === 'open' || mode === 'closed') learned = mode;
          }
          return answer;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }

      return {
        async call({ caller, model, max_tokens }) {
          const cacheKey = `${caller}\n${model}\n${max_tokens}`;
          if ((cache.get(cacheKey) ?? 0) > Date.now()) {
            last = { decisionId: null };
            return { outcome: 'sent', model };
          }
          const body = { gateway: { kind: canReroute ? 'litellm' : 'generic' }, callers: [{ kind: 'tag', id: caller }], model, max_tokens, accepts_models: models };
          if (!canReroute) body.can_reroute = false;
          const answer = await admit(body);
          if (!answer) {
            // TensorCost failed: the fail mode decides.
            const mode = learned ?? configured;
            last = { decisionId: null };
            return mode === 'open' ? { outcome: 'sent', model } : { outcome: 'blocked', message: "TensorCost couldn't check this call's budget." };
          }
          if (answer.decision === 'refuse') return { outcome: 'blocked', message: answer.message ?? 'TensorCost refused this call.' };
          last = { decisionId: answer.decision_id };
          if (answer.decision === 'reroute' && canReroute && answer.model) return { outcome: 'sent', model: answer.model };
          if (faults.cacheAll) cache.set(cacheKey, Date.now() + 5000);
          else if (answer.cache_ttl_seconds > 0 && !answer.degraded && answer.fail_mode_known !== false && answer.reservation_cents === 0) {
            cache.set(cacheKey, Date.now() + answer.cache_ttl_seconds * 1000);
          }
          return { outcome: 'sent', model };
        },
        async fail(outcome) {
          // Cancel only when the provider provably did no model work.
          if (!last?.decisionId) return;
          if (!faults.cancelAll && (outcome.timeout || !NEVER_BILLED.has(outcome.status))) return;
          await fetch(`${url}/v1/gateway/admit/${last.decisionId}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
        },
      };
    },
  };
}
