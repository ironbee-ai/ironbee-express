# Web UI

The web UI runs a goal and shows it as it happens: a live view of the browser, every step, and the
verdict with the evidence behind it.

```bash
ibexpress ui          # from a checkout: npm run dev -- ui
# IronBee Express UI: http://127.0.0.1:15986
```

The UI runs one goal at a time. See [Configuration](configuration.md#ibexpress-ui) for its flags.

## The top bar

Three status pills, green when ready and red when not. Hover over one for details.

- **Jev**: whether the decision engine answers. A missing or wrong `TYPESAFE_API_KEY` shows here.
- **IronBee**: whether runs are reported to IronBee. When they are not, it is a **Connect IronBee**
  button. See [Connect IronBee](#connect-ironbee).
- **Live view**: whether the browser can be shown in the page. It is off when the UI uses a daemon
  started elsewhere.

## The run form

- **Start URL** and **Goal**: write the goal as one plain sentence, and put the exact texts to type
  in quotes, for example: Log in, add the "iPhone 15 Pro" to the cart, then open the cart.
- **Browser**: **Fresh** starts every run in a clean browser. A saved profile keeps its cookies and
  logins between runs, so you can sign in once. **+ New profile…** creates one, **Delete** removes
  it.
- **Values**: texts the agent may type, each with a name and an optional description of what it is
  for. Turn on **secret** for a value no model may see, and **password** for a login password. See
  [Text and secrets](text-and-secrets.md).
- **Text**: whether strings quoted in the goal may be typed, and which text model, if any, writes a
  value when none of yours fits. Only providers that are set up can be picked.
- **Scenario**: save the form under a name. See [Scenarios](#scenarios).

**Run** starts the run and **Stop** cancels it. **Clear** empties the form, and also the last result
when no run is going.

The form is remembered in your browser for the next visit. Secret values are not, so type them again
after a reload.

## Scenarios

A scenario is the form saved under a name. See [Scenarios](scenarios.md) for how recordings and
replays work.

- **Save** stores the form as a scenario without running it. It asks before replacing one with the
  same name. Running never saves a scenario.
- **Re-explore with the engine** ignores the scenario's recording for this run.
- **Saved scenarios**, under the form, lists every scenario. **Load** fills the form (type the
  secrets again), **Clear cache** drops its recordings, and **Delete** removes it.

## The live view

While a run is going, the page appears in a browser frame with its address bar. Each action is
marked on the page, so you can follow what was done. Above it are the run's time, the number of
steps and actions, and its phase. The time does not include opening the browser or your turns.

## Steps

The **Steps** tab lists every step as it happens: its number, the time since the start, a mark, the
action and what it acted on.

- A green ✓ means the step was done and the page changed. A grey ✓ means it was done but the page
  stayed the same. A ✗ means it was not done; open the step for the reason.
- A badge says who decided the step: **engine** (Jev), **replay** (from a scenario's recording) or
  **LLM** (the text model, while it had the controls; see
  [Text and secrets](text-and-secrets.md#when-the-engine-is-stuck)).
- A step that typed text shows where the text came from: one of your values, a secret (masked), the
  goal, the text model, or you.

Open a step to see how it was decided. Warnings, such as a report IronBee rejected, appear above the
steps. A warning never changes the verdict.

## Result

The **Result** tab shows the verdict when the run ends, and the review a few seconds later. See
[Review](review.md) for how it is reached.

- PASSED or FAILED, with a one-line summary, the time and the number of actions.
- Whether the goal was done, and whether the run explored or replayed a recording.
- With a text model, a failed run also gets a short explanation of what went wrong.
- Problems, numbered F1, F2 and so on, each with a severity (minor, major or critical) and where it
  was seen. The **show** links open the requests, spans or log records it is based on.
- Whether the run was reported to IronBee, and a download link for the video.

The **Requests** tab lists the app's API requests during the run, with secrets masked. With IronBee
connected, **Traces** shows the run from the browser through each backend service, and **Logs** the
backend log records. Items a problem is based on carry its F number in these tabs.

## Your turn

Some steps only a person can do: a social or single sign-on login, a CAPTCHA, a code sent to your
phone or email, or a field that needs a value nothing in the run provides. Jev then hands the browser
to you.

1. A **Your turn** bar appears over the live view with a short prompt, for example "Sign in on the
   page".
2. Act on the page in the live view. Your clicks and typing go to the browser.
3. Press **Continue** when you are done, and the run goes on from where you left it. **Stop run**
   ends the run.

The time you take is not counted. A saved scenario records the hand-over, so a replay pauses at the
same point.

From the terminal this works with `--headed`: you act in the browser window, then press Enter to
continue or type `stop`. Without `--headed`, nobody can take over, and a run that needs a person ends
as blocked.

## Connect IronBee

When runs are not reported to IronBee, the top bar shows **Connect IronBee**.

1. Press **Connect IronBee**. The IronBee console opens in a new tab.
2. Sign in, or create a free account with Google, GitHub or email.
3. The tab closes and the UI says it is connected. The next run is reported, and its review includes
   the backend trace.

The login is saved in `~/.ironbee/config.json` and shared with the IronBee CLI and editor extension.
**sign out** next to the pill removes it. When the credential comes from the environment, the UI
offers neither. See [IronBee](ironbee.md).

## Running it on another address

By default only this machine can open the UI. To open it from another machine, start it with
`--host 0.0.0.0` (or the machine's address) and open it by IP address. **Connect IronBee** works only
from a browser on the machine the UI runs on, and only when the UI listens on `127.0.0.1`,
`localhost` or `0.0.0.0`.
