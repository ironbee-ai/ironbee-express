# Text and secrets

The decision engine chooses what to do, but it does not write text. When a step types into a field,
the engine picks the text from the choices the run offers. This page covers where those choices come
from, how to add a text model, and how secrets are kept from every model.

## Where typed text comes from

| Source | How you give it | What the engine sees |
| --- | --- | --- |
| Your values | `--value name=text`, or a row under **Values** in the UI | the value |
| Your secrets | `--secret name=text` or `--password name=text`, or a row with **secret** on | the name only |
| Quoted text | a string the goal puts in quotes, for example `"Istanbul"` | the text |
| A text model | `--text-model provider/model`, or the UI's model picker | the model writes a value for the field |
| You | [your turn](web-ui.md#your-turn), when nothing else provides a value | nothing |

Give a value a description when its name does not match the field's label, for example
`--value-desc card="the payment card number"`, or the second line of a row in the UI. The engine uses
it to match the value to the right field.

Without a text model, quoting the texts in the goal is the simplest way to have them typed exactly as
written. `--text-candidates supplied` turns quoted text off.

A page may have one field for several parts of the goal, such as a single address field for the street,
the city and the postal code. When a second text goes into a field that still holds the first, the
engine decides whether the new text replaces the old one or is added to it. A secret is never joined
with other text.

## Text models

A text model is optional. When one is set, it writes a value for a field when none of yours fits,
explains a failed run, and can [take the controls](#when-the-engine-is-stuck) when the engine is
stuck.

| Provider | Available when |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` is set |
| `openai` | `OPENAI_API_KEY` is set |
| `openrouter` | `OPENROUTER_API_KEY` is set |
| `claude-code` | the Claude Code CLI (`claude`) is installed and logged in |
| `codex` | the Codex CLI (`codex`) is installed and logged in |

A model is written `provider/model`, for example `anthropic/claude-haiku-4-5`,
`openrouter/inception/mercury-2.5` or `claude-code/opus`. Set it per run with `--text-model` (or
`none`), or for every run with `IBEXPRESS_TEXT_MODEL`. In the web UI, the model picker lists the
models of each provider that is set up.

To pick one:

- An API provider answers in about a second per value.
- A CLI provider takes several seconds per value. It is useful when you have a Claude Code or Codex
  login and no API key.

The CLIs use their own login and do not see your project's files or API keys. A Claude Code set up
for Bedrock, Vertex or an LLM gateway through environment variables does not work here; it needs its
own login.

`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and `OPENROUTER_BASE_URL` point a provider at another
endpoint, for example a local OpenAI-compatible server.

## Secrets and passwords

A secret is a value that is typed into the page but never shown to any model. Give it with
`--secret name=text`, or `--secret name=env:VAR` to read it from an environment variable. In the UI,
turn on **secret** in the value's row.

A login password is a secret given with `--password` (or **password** in the UI). It is typed only
into password fields of the start site.

- The engine chooses a secret by its name and never receives the value.
- A secret is typed only on the start site. If a page asks for it anywhere else, or asks for a
  password in a field that is not a password field, the action is refused and the run goes on.
- Secret values are hidden in everything a model sees: page text, API responses, logs and traces.
- Secret values are never written to a scenario or a recording, and the web UI does not store them.

With `IBEXPRESS_IFRAMES=true`, secrets other than passwords may also be typed into frames the start
site embeds, such as a payment form.

The start-site and password-field rules apply when IronBee Express starts the browser itself and the
run has a start URL. With a daemon you started yourself, or without a start URL, secrets are still
hidden from every model but are not limited to the start site.

## When the engine is stuck

With a text model selected, a run does not have to end where the engine gets stuck. The text model
takes the controls when the engine repeats itself, makes no progress, keeps claiming DONE without the
evidence, or reports that it is blocked.

Its job is to get the run past the obstacle, then hand back to the engine. While it has the
controls, it looks at the page and acts one step at a time, using the same controls and checks as
the engine. It can choose a secret by name but never sees its value. It ends by handing back, by
confirming the goal is done, or by giving up with a reason. It takes over only a few times per run.

In the web UI its steps are marked **LLM** and a notice shows what it is doing. See
[Web UI](web-ui.md#steps).
