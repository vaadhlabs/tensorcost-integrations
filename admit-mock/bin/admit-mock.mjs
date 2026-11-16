#!/usr/bin/env node
// npx @tensorcost/admit-mock --port 8787
import { createMock } from '../src/server.mjs';

const USAGE = `admit-mock: a local TensorCost admit route for testing a gateway client.

  --port <n>           port to listen on (8787; 0 picks a free one)
  --host <addr>        address to listen on (127.0.0.1)
  --fail-mode <mode>   the workspace's fail mode the answers carry: open or closed (open)
  --gateway-kind <k>   the connection's gateway kind (default: the request's gateway.kind)
  --key <tcgw_...>     the only gateway key to accept (default: any bearer token)
  --slow-ms <n>        how long slow-* callers wait when the id names no time (1500)
  --openapi <path>     the admit OpenAPI file to check requests and answers against
  --no-openapi         check nothing against the OpenAPI file

Caller ids pick the answer: refuse-*, reroute-*, slow-*, error-*, degraded-*,
unavailable-*, throttled-*, cache-*, unknown-mode-*; anything else is allowed.
GET /_mock/log shows what the mock was sent and answered.`;

function parse(argv) {
  const opts = { port: 8787, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--port') opts.port = Number(value());
    else if (a === '--host') opts.host = value();
    else if (a === '--fail-mode') opts.failMode = value();
    else if (a === '--gateway-kind') opts.gatewayKind = value();
    else if (a === '--key') opts.key = value();
    else if (a === '--slow-ms') opts.slowMs = Number(value());
    else if (a === '--openapi') opts.spec = value();
    else if (a === '--no-openapi') opts.spec = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be 0 to 65535');
  if (opts.slowMs !== undefined && !(opts.slowMs >= 0)) throw new Error('--slow-ms must be a number of milliseconds');
  return opts;
}

try {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const mock = createMock(opts);
  const url = await mock.listen(opts.port, opts.host);
  // The first line is the address, for scripts that start the mock on port 0.
  console.log(`admit-mock listening on ${url}`);
  console.log(mock.spec ? `checking against ${mock.spec}` : 'not checking against an OpenAPI file');
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  console.error(`admit-mock: ${err.message}`);
  process.exit(2);
}
