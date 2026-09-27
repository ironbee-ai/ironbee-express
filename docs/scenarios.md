# Scenarios

A scenario is a saved prompt: the start URL, the goal, your values, the names of your secrets (and
which are passwords), the text model setting and the browser profile. When a run of a scenario
passes, IronBee Express records how it was done. The next run replays that recording without asking
the engine for each step, which is much faster.

```bash
# save the prompt as "checkout" and run it; the engine explores
ibexpress run --url https://eshop.demo.ironbee.dev/ --goal "…" \
  --value email=demo@example.com --password password=env:ESHOP_PW --save-as checkout

# replay the recording
ibexpress run --scenario checkout --password password=env:ESHOP_PW

# let the engine decide every step again
ibexpress run --scenario checkout --password password=env:ESHOP_PW --explore
```

In the web UI the same is done with **Save**, **Load** and **Re-explore with the engine**. See
[Web UI](web-ui.md#scenarios).

## Saving

A scenario is saved only when you ask for it: `--save-as <name>` on the CLI, or **Save** in the UI.
A run never changes a scenario. Saving under an existing name updates that scenario.

Scenarios are plain JSON files in the scenario directory (`IBEXPRESS_SCENARIO_DIR`, by default the
package's `examples/scenarios`), meant to be committed and shared.

Secret values are never saved, only their names. Give them again each time you run the scenario,
with `--secret` or `--password` on the CLI or in the value rows of the UI.

## Recordings

A recording is made when a run of a scenario passes its [review](review.md). Recordings are kept in
`./.ibexpress/cache` (`IBEXPRESS_CACHE_DIR`), which is not meant to be committed.

- A scenario has one recording per goal and start URL. If you edit the goal, the new goal gets its
  own recording, and going back to the old goal finds the old one.
- A recording types your values and secrets by name, so a replay with different values takes the
  same steps.

## Replay

A replay repeats the recorded steps on the live page, then the engine checks the goal and reviews
the run as usual. So a replay still needs the engine, only not for each step.

If you were asked to act during the recorded run (a login, a CAPTCHA), the replay pauses at the same
point and waits for you again. See [Your turn](web-ui.md#your-turn).

## Healing

If the page has changed and a recorded step no longer fits, or the goal is not done at the end, the
engine takes over from that point and finishes the run. If that run passes, its recording replaces
the old one.

`--no-heal` ends the run at that point instead.

## Clearing recordings

To make the next run of a scenario explore again, clear its recordings:

- `ibexpress scenarios clear-cache <name>`, or `--all` for every scenario;
- **Clear cache** in the UI's scenario list;
- deleting the scenario, which removes its recordings too.

`--explore` (**Re-explore with the engine** in the UI) ignores the recording for one run without
clearing it.
