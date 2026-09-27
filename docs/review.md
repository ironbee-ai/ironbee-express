# How a run is judged

You write no assertions. The decision engine, Jev, judges the run on what the run shows: the pages,
the app's API responses, the browser console and, with [IronBee](ironbee.md) connected, the logs and
traces of the backend services.

A run is judged twice: when the agent says the goal is done, and after the run ends.

## When the agent says DONE

DONE is only a claim. The page is read again together with the run's API responses, and the engine
decides where the goal stands:

| Goal | Meaning | What happens |
| --- | --- | --- |
| done | Every part of the goal is done, and the evidence shows it. | DONE is accepted. |
| not yet | Something is still missing, for example a step or a page that is still loading. | The agent keeps going. If it keeps claiming DONE without the evidence, the run ends FAILED, or a text model takes over (see [Text and secrets](text-and-secrets.md#when-the-engine-is-stuck)). |
| failed | The evidence shows the goal failed and more steps will not fix it. | The run ends FAILED. |

The engine also points at the evidence behind its answer, such as an API response or a log record,
and the result shows it.

## After the run: the review

1. Everything that might be a problem is collected: failed requests and error responses, console
   errors and, with IronBee, failed or slow backend operations and warning or error logs.
2. The engine rates each one for your goal:
   - none: expected or harmless, such as a 401 before logging in;
   - minor: noise or a cosmetic error, reported but never failing the run;
   - major: a real bug that affects the flow or its data;
   - critical: the goal's main result failed or is wrong.
3. The run passed when it ended DONE, the goal is judged done, and no problem is rated major or
   critical. Otherwise it failed, with a one-line summary.
4. With a text model, a failed run also gets a short explanation of what went wrong. It never
   changes the verdict.

In the web UI, each problem is listed with where it was seen. See [Web UI](web-ui.md#result).

## What IronBee adds

Without IronBee, the review sees only the browser, so a backend failure counts only when the page or
an API response shows it. With IronBee connected, the backend services' traces and logs are part of
the evidence. A run fails when the page says "Order placed successfully!" while a backend service
logged that the order could not be processed.

## Limits

- The verdict is the engine's judgement, so it can vary between runs.
- Minor problems are reported but never fail a run.
- When the engine cannot be reached after the run, the run is not reviewed, and the CLI's exit code
  follows whether the run ended DONE.
