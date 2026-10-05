# IronBee Express documentation

Start with the [README](../README.md) for an overview and the quick start.

## Using it

- [Examples](examples.md): ready-made scenarios and how to run them
- [Web UI](web-ui.md): the run form, the live view, the result, your turn, connecting IronBee
- [Configuration](configuration.md): the common environment variables and CLI commands
- [Text and secrets](text-and-secrets.md): values, secrets and passwords, text models

## Understanding a result

- [Review](review.md): how a run is judged and what PASSED and FAILED mean
- [Scenarios](scenarios.md): saving a prompt, replaying it and clearing its recordings
- [IronBee](ironbee.md): connecting to the IronBee platform and what it adds
- [Web Bot Auth](web-bot-auth.md): registering IronBee's hosted agent with the bot-protection vendors

## Contributing

Before sending a change, run `npm run lint && npm test && npm run build`.

The live test suites drive a real browser, and are skipped unless told which daemon to use:

```bash
# local test pages; starts the daemon that npm install brought
IBEXPRESS_E2E_DAEMON_SCRIPT=node_modules/@ironbee-ai/devtools/dist/daemon-server.js npx jest tests/integration/control tests/integration/secrets

# IronBee's e-shop demo, through a daemon already running at that address
IBEXPRESS_E2E_DAEMON_URL=http://127.0.0.1:2099 npx jest tests/integration/eshop
```
