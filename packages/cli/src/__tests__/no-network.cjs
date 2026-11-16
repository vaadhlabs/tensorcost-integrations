// Preloaded with `node --require` by the integration tests. Any attempt to reach
// the network ends the process with exit code 99, so the audit's promise is
// checked against the built binary rather than taken on trust.
const net = require("net");
const dns = require("dns");

function trip(what) {
  process.stderr.write(`NETWORK_ATTEMPT ${what}\n`);
  process.exit(99);
}

net.Socket.prototype.connect = () => trip("net.Socket.connect");
dns.lookup = () => trip("dns.lookup");
globalThis.fetch = () => trip("fetch");
