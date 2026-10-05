# Configuration

IronBee Express reads its settings from environment variables. The CLI loads a `.env` file from the
working directory first, without overriding variables that are already set. CLI flags and the web
UI's form override the environment for one run.

A switch is off for `0`, `false`, `no` or `off`, and on for anything else.

## Environment variables

Most setups need only the TypeSafe key, and optionally a text model key and an IronBee login.

| Variable | Default | What it does |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | Your TypeSafe key for the Jev engine. Required. |
| `IBEXPRESS_TEXT_MODEL` | none | The default text model, as `provider/model`, for example `anthropic/claude-haiku-4-5` or `claude-code/opus`. See [Text and secrets](text-and-secrets.md#text-models). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | none | Each one makes that text model provider available. |
| `CLAUDE_CODE_CLI`, `CODEX_CLI` | found on `PATH` | Path of the Claude Code or Codex CLI, when it is not on `PATH`. |
| `IRONBEE_API_KEY` or `IRONBEE_OAUTH_TOKEN` | the saved IronBee login | An IronBee credential. Setting one turns reporting on. See [IronBee](ironbee.md). |
| `IRONBEE_DOMAIN` | `ironbee.ai` | The IronBee platform domain. |
| `IBEXPRESS_PROJECT_NAME` | the working directory's name | The IronBee project runs are filed under. |
| `IBEXPRESS_IRONBEE_REPORT` | on when a credential is found | `off` keeps the credential but reports nothing. |

Browser, web UI and storage:

| Variable | Default | What it does |
| --- | --- | --- |
| `IRONBEE_DEVTOOLS_DAEMON_SCRIPT` | the installed `@ironbee-ai/devtools` package | The DevTools `daemon-server.js` to start, for example `../ironbee-devtools/dist/daemon-server.js`. |
| `IRONBEE_DEVTOOLS_DAEMON_URL` | none | Use a DevTools daemon that is already running at this URL. |
| `IBEXPRESS_DAEMON_PORT` | `2071` | Port of the daemon a CLI run starts. |
| `IBEXPRESS_HEADLESS` | `true` | Run the browser without a window. `--headed` overrides it. |
| `IBEXPRESS_IFRAMES` | `false` | Let the agent use controls inside the page's iframes, such as an embedded payment form. Keep it off where the start site embeds content you do not trust. |
| `IBEXPRESS_STEALTH` | `false` | Run in the [stealth browser](#sites-that-refuse-the-browser) by default. `--stealth`, a scenario or the UI's checkbox turns it on per run. |
| `IBEXPRESS_UI_HOST` | `127.0.0.1` | Address the web UI listens on. |
| `IBEXPRESS_UI_PORT` | `15986` | Port the web UI listens on. |
| `IBEXPRESS_SCENARIO_DIR` | the package's `examples/scenarios` | Where saved scenarios are kept. |
| `IBEXPRESS_CACHE_DIR` | `./.ibexpress/cache` | Where recordings of passing runs are cached. |
| `IBEXPRESS_PROFILE_DIR` | `./.ibexpress/profiles` | Where saved browser profiles are kept. |
| `IBEXPRESS_MAX_ACTIONS` | `60` | The most actions one run may take. |

### Engine

Jev is the only decision engine today (`IBEXPRESS_ENGINE=jev`, the default). It needs
`TYPESAFE_API_KEY`.

## CLI

The command is `ibexpress`. From a checkout, run it as `npm run dev -- <command>` or, after
`npm run build`, `node dist/cli/main.js`. Every command lists all of its flags with
`ibexpress <command> --help`.

### `ibexpress run`

Runs one goal in the terminal.

```bash
ibexpress run --url <start page> --goal <text> [options]
ibexpress run --scenario <name> [options]
```

| Flag | What it does |
| --- | --- |
| `--goal <text>` | What to accomplish. |
| `--url <url>` | The start page. |
| `--scenario <name>` | Run a saved scenario. See [Scenarios](scenarios.md). |
| `--save-as <name>` | Save this prompt as a scenario, then run it. |
| `--explore` | Ignore the scenario's recording for this run. |
| `--value <name=text>` | A value the agent may type. Repeatable. |
| `--secret <name=text>` | A value that is typed but never shown to any model. `text` may be `env:VAR`. Repeatable. |
| `--password <name=text>` | A secret that is a login password. Accepts `env:VAR`. Repeatable. |
| `--value-desc <name=text>` | What a value or secret is for, for example `card="the payment card number"`. |
| `--text-model <provider/model>` | The text model for this run, or `none`. |
| `--profile <name>` | Run in a saved browser profile. `none` means a fresh browser. |
| `--stealth` | Run in the [stealth browser](#sites-that-refuse-the-browser), for a site whose bot protection refuses the normal one. |
| `--headed` | Show the browser window. Needed for [your turn](web-ui.md#your-turn) in a terminal. |
| `--record` | Record a video of the run. |
| `--json` | Print the result as JSON. |

The exit code is `0` when the run passed its [review](review.md) and `1` otherwise. When the run
could not be reviewed, it is `0` if the run ended DONE.

### `ibexpress ui`

Serves the web UI. See [Web UI](web-ui.md).

```bash
ibexpress ui [--port <n>] [--host <host>] [--headed] [--daemon-script <path>]
```

### `ibexpress scenarios` and `ibexpress profiles`

| Command | What it does |
| --- | --- |
| `ibexpress scenarios list` | List saved scenarios and how many recordings each has cached. |
| `ibexpress scenarios show <name>` | Print a scenario. |
| `ibexpress scenarios delete <name>` | Delete a scenario and its recordings. |
| `ibexpress scenarios clear-cache <name>` | Drop a scenario's recordings, so its next run explores. `--all` does it for every scenario. |
| `ibexpress profiles list` | List saved browser profiles. |
| `ibexpress profiles delete <name>` | Delete a profile with every cookie and login in it. |

A profile is created the first time a run uses it, or with **+ New profile…** in the web UI.

## The DevTools daemon

The browser runs inside an [IronBee DevTools](https://github.com/ironbee-ai/ironbee-devtools) daemon.
IronBee Express starts one by itself when it needs one, so there is usually nothing to set up. A CLI
run reuses a daemon that is already answering on its port.

You can point IronBee Express at a daemon you run yourself with `--daemon-url`. A browser profile
cannot be used that way, and the web UI has no live view with it. Such a daemon needs `TOOL_PLUGINS`
set to this package's `dist/devtools-plugin/control-tools.mjs`, and for the full feature set also
`BROWSER_DIALOG_MODE=hold`, `BROWSER_FOLLOW_NEW_TABS=true` and `TOOL_INPUT_METADATA_ENABLE=true`.

## Sites that refuse the browser

Sites behind bot protection (Cloudflare, Akamai, DataDome, HUMAN, Kasada) refuse a browser that
looks automated, before the agent takes a step: a "Just a moment…" page, "Access denied", a
"Press & Hold" box. The browser IronBee Express starts already looks like the one a person runs:
your Chrome when it is installed, a real window, no headless marks, the page's security policy
kept. That gets past most of them. For the ones that still refuse it:

- **The stealth browser** (`--stealth`, the UI's *Stealth browser* checkbox, or a scenario's
  `stealth`). It leaves no automation trace a page can read. It captures no console messages, so
  the review sees none, the IronBee trace has no browser spans, and the live view shows no marks
  where the agent clicks. Use it for sites that need it.
- **When the run's last page is still a bot check**, the run says so in a warning (and in the UI's
  *Bot check* line): the site refused the browser, which is not the app's doing.
- **Your network matters too.** Sites rate addresses: a home or office connection gets through
  where a cloud server's address is refused. Testing your own site? Allow the agent in your bot
  protection's settings instead (an allow rule for your test runs).
- **Behind a proxy** (`BROWSER_PROXY_SERVER`), give the browser the clock and language of the
  proxy's country, so they match its address: for a US one, `TZ=America/New_York` and
  `BROWSER_LAUNCH_ARGS=--accept-lang=en-US`.
- **A CAPTCHA or "Verify you are human" box** needs a person: the run hands the browser over (see
  [your turn](web-ui.md#your-turn)).

