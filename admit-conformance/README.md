# Admit client conformance cases

The cases a gateway client is tested with against `@tensorcost/admit-mock`,
one for each rule in `spec/admit/README.md` that a client can get wrong.
Apache-2.0.

`cases.json` holds them in a form any language can read. Each case sets the
client's fail mode, makes calls through it with a caller id that picks the
mock's answer, and says what must happen: whether the call is sent, to which
model, or blocked, whether the client asked admit, and whether it cancelled a
hold after the provider failed a certain way. At the end it counts the admits
and cancels the mock saw, and every admit request must match the OpenAPI file.

A case's `level` is `must` (the protocol requires it) or `should` (following a
reroute, cancelling a never-billed call). `needs` names what a client must be
able to do for the case to apply: `reroute` (it can rewrite a call's model),
`no_reroute` (it can't, and sends `can_reroute: false`), `cancel` (it calls
the cancel route). A client skips the cases it doesn't meet and passes the rest.

## Running them

For a client written in JavaScript, wrap it in an adapter and call
`runCases` from `lib/runner.mjs`, which documents the adapter's shape.
`lib/reference-client.mjs` is a short client that follows the protocol, and
`test/conformance.test.mjs` runs it.

For any other language, start the mock (`node admit-mock/bin/admit-mock.mjs
--port 0` prints its address on the first line), read `cases.json`, and drive
your client the way `lib/runner.mjs` does, reading `GET /_mock/log` between
steps. `litellm/tests/test_conformance.py` does this for the LiteLLM plugin
in Python.

The calls use the `client` block's model, `max_tokens`, model list (as the
client's `accepts_models`) and a 1,000 ms admit timeout; a case that waits on
a `slow-1500` caller relies on the client giving up before 1,500 ms.

## Tests

`npm test` runs the reference client through every case, and checks that a
client breaking each rule on purpose fails the case for that rule.
