# IronBee platform

Connecting [IronBee](https://ironbee.ai) is optional. With it:

- every run is reported to the platform as a session, with its verdict, its steps and its video;
- the run's trace, from the browser through every backend service its requests reached, is added to
  the [review](review.md), so a backend failure the page hides still fails the run.

Without IronBee everything else works the same. Runs are not reported, and the review sees only the
browser.

## Connecting

You need only one of these:

- In the web UI, press **Connect IronBee** and sign in or sign up in the tab that opens (Google,
  GitHub or email; it is free). See [Web UI](web-ui.md#connect-ironbee).
- Sign in with the IronBee CLI (`ironbee login`) or the IronBee editor extension. IronBee Express uses
  the same saved login, `~/.ironbee/config.json`.
- Set a credential in the environment:

```bash
IRONBEE_API_KEY=…             # or IRONBEE_OAUTH_TOKEN, a personal token
IRONBEE_DOMAIN=ironbee.dev    # default ironbee.ai
IBEXPRESS_PROJECT_NAME=eshop  # default: the working directory's name
IBEXPRESS_IRONBEE_REPORT=off  # keep the credential but report nothing
```

Signing out in the UI removes the saved login. The token stays valid until it expires; delete it in
the console under Settings, Access tokens if you want it gone at once.

## What a run reports

Each run becomes a session in the project, named after the scenario or the goal. It holds the
verdict with every problem found, the steps the run took, the video when the run was recorded (every
web UI run is, a CLI run with `--record`), and the trace through every backend service that is
instrumented with OpenTelemetry.

Reporting never fails a run. If the platform cannot be reached or rejects a report, the run shows a
warning and the result says it was not reported.

## The trace in the review

After the run, IronBee Express reads the run's trace back from IronBee. Failed or slow backend
operations and warning or error logs are reviewed with the rest of the run, and the engine can point
at a backend log as the reason the goal failed. The web UI shows the trace and logs in the
**Traces** and **Logs** tabs, and the CLI prints a summary (`--show-logs` prints every log record).

With a DevTools daemon you started yourself, see
[Configuration](configuration.md#the-devtools-daemon) for the setting it needs to report the run's
steps and video.
