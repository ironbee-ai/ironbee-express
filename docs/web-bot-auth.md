# Web Bot Auth: registering IronBee's agent

How IronBee's hosted agent gets a verified identity with the bot-protection vendors (as of
2026-10-03).

IronBee's hosted agent can sign its requests with
[Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)
and present itself to sites as IronBee. It needs three things:
- an Ed25519 key;
- a signed key directory on `ironbee.ai`;
- a registration with each bot-protection vendor.

The signing is built. IronBee DevTools `0.51.0` signs every https request the browser sends
once two environment variables are set: `BROWSER_WEB_BOT_AUTH_KEY` and `BROWSER_WEB_BOT_AUTH_AGENT`.
That covers pages, their cross-site frames, workers, service workers and a popup's first request, and
every redirect hop is signed for its own host. A cleartext `http:` request is not signed (but to
`localhost`): the signature covers the host, not the scheme, so anyone on its way could replay it to
the site over https until it expires. For the same reason certificates are checked while it signs:
`BROWSER_IGNORE_HTTPS_ERRORS` defaults to `false` with it, and `true` stops DevTools at start-up
(a proxy answering with a certificate of its own would otherwise read the signature). Cloudflare's research verifier counted both a direct
navigation and a cross-host redirect `valid`, under Playwright and patchright alike.

**Why.** Hosted runs leave from a cloud address. Cloudflare's challenge pages refuse a cloud address
whatever the browser looks like: 3 of 8 protected sites opened from the hosted agent. With a
verified signature, a site decides by who the agent is, not by where it comes from.

**Order matters.** Signing is turned on only after approval. Before that, a signed request comes
from an unknown bot: AWS WAF labels it `unknown_bot` and advises blocking it.

```
once:           key ─▶ key directory on ironbee.ai ─▶ apply to the vendor ─▶ approved: the key is listed
every request:  the agent signs ─▶ the site's bot protection verifies ─▶ the owner's rule ─▶ the site
```

## 0. Decisions

| Decision | Proposal | Why |
| --- | --- | --- |
| Identity (`Signature-Agent`) | `https://ironbee.ai` | The name sites see; the key directory lives on this origin. `https://agent.ironbee.ai` works too if the directory is served apart from the site |
| Cloudflare behavior | Agent (plus Monitoring & Operations if verifications run on a schedule) | A user-directed agent that visits pages on a person's behalf |
| Access label | Intermediary | Many customers run the agent; each run is started by a different one |
| Keys | One per environment; only production's is registered | A leaked development key cannot sign as production |
| Who signs | The hosted agent only | IronBee Express runs on the user's machine; the private key cannot be handed out |

The behavior and the label are declared in the application. If the traffic does not match the
declared purpose, the vendor delists the agent.

## 1. The key

Generate an Ed25519 key for production; Cloudflare accepts Ed25519 only. The private key lives only
in production's secret store.

```sh
openssl genpkey -algorithm ed25519 -out ironbee-wba-prod.pem
```

The `keyid` is the public key's RFC 7638 thumbprint, and the directory's body is a JWKS. Node prints
both (checked against RFC 8037's test vector):

```sh
node -e '
const crypto = require("crypto"), fs = require("fs");
const { kty, crv, x } = crypto.createPublicKey(fs.readFileSync(process.argv[1])).export({ format: "jwk" });
console.log("keyid:", crypto.createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url"));
console.log(JSON.stringify({ keys: [{ kty, crv, x }] }));
' ironbee-wba-prod.pem
```

Then move the private key into the secret store and delete the file. DevTools reads the key as a
PKCS#8 PEM or as a JWK (JSON).

## 2. The key directory

`https://ironbee.ai/.well-known/http-message-signatures-directory` serves the public key. Every
response is signed anew. Cloudflare's requirements:

| Field | Value |
| --- | --- |
| Response | HTTPS, `200`; no redirect, no WAF challenge |
| `Content-Type` | `application/http-message-signatures-directory+json` |
| Body | A JWKS: `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"…"}]}`, never the private `d` |
| `Signature-Input` | `sig1=("@authority";req);alg="ed25519";keyid="<keyid>";tag="http-message-signatures-directory";created=<now>;expires=<shortly after>` |
| `Signature` | One for each key in the directory, made with that key |

- **Serving it.** The signature changes with every request, so a static file will not do; a small
  function behind the CDN will.
  - It reads the private key from the secret store and signs `@authority` as `ironbee.ai`.
  - The CDN must not cache the path, or it serves an expired signature.
- **Reference.** Cloudflare's worker that signs its own directory is `examples/verification-workers`
  in [cloudflare/web-bot-auth](https://github.com/cloudflare/web-bot-auth). DevTools'
  `keyDirectory()` builds the same JWKS body.
- **Check it** with Cloudflare's validator:

```sh
cargo install http-signature-directory
http-signature-directory https://ironbee.ai/.well-known/http-message-signatures-directory
```

## 3. A public page about the agent

The application and site owners need one page about the agent, e.g. `https://ironbee.ai/agent`
(address to be decided). It says:

- **What it does:** a test agent that verifies customers' own web applications end to end. Each run
  is started by a customer.
- **How to recognize it:** `Signature-Agent: "https://ironbee.ai"` and the directory's address. The
  User-Agent is an ordinary Chrome's; the identity is in the signature.
- **Where it comes from:** production's fixed egress address, for owners who prefer an IP rule.
- **How to allow or block it:**
  - Cloudflare: by IronBee's name or the Agent behavior;
  - AWS WAF: by the `web_bot_auth:verified` and bot-name labels;
  - robots.txt: by the `IronBee` token ([section 8](#8-before-signing-and-running-it)).
- **Contact:** an address for support and abuse reports.

A draft also defines a machine-readable version, the Signature Agent Card. Cloudflare's example
serves one at `/signature-agent-card`; it is optional for now.

## 4. Test before applying

Test the signature's format on Cloudflare's test endpoint before applying. No real site gets signed
requests yet.

How the command below works:
- IronBee Express passes its environment to the daemon it starts.
- A `${file:…}` reference keeps the key out of the environment. The single quotes matter: without
  them the shell expands `${file:…}` itself.
- `--port` starts a fresh daemon, so a running daemon without the key is not reused.

```sh
BROWSER_WEB_BOT_AUTH_KEY='${file:~/ironbee-wba-dev.pem}' \
BROWSER_WEB_BOT_AUTH_AGENT=https://ironbee.ai \
npm run dev -- run --port 2099 --headed --keep-open \
  --url https://crawltest.com/cdn-cgi/web-bot-auth --goal "Read what the page says"
```

| crawltest answers | Meaning | Expected |
| --- | --- | --- |
| `400` | Malformed: the headers or the signature base | Never; fix it |
| `401` | Well-formed, but the key is unknown | Before registration |
| `200` | The key is registered and the signature verified | After approval |

**The key in a hosted run.** A browser that can open `file://` URLs can read the files of the machine
it runs on, including the process environment (`/proc/self/environ`). So give DevTools the key as a
`${file:…}` reference, and delete the file once DevTools has started; DevTools reads the key once,
at start.

## 5. Apply to Cloudflare

The application is a form in IronBee's Cloudflare account, with the signature as the verification
method. Any Cloudflare account can submit it.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/configurations/verified-bots),
   open **Manage Account → Configurations → Bot Submission Form**.
2. **Verification Method:** Request Signature.
3. **Validation Instructions:** `https://ironbee.ai/.well-known/http-message-signatures-directory`.
   User-Agent patterns are optional; give none, since the identity is in the signature.
4. Fill in the behavior (Agent), the access label (Intermediary), the name, the description and the
   agent page's address, then **Submit**.

How long a review takes is not documented; automated checks have run since 2026-08-28. An approved
agent is listed in BotBase and in
[Cloudflare Radar's bots and agents directory](https://radar.cloudflare.com/bots/directory).

[Verified bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/) requires:
- honest self-identification, which the signature gives;
- obeying robots.txt and crawl directives, at reasonable request rates;
- never evading a site owner's preferences. A service whose traffic does not match its declared
  purpose is removed.

So a signed identity is never combined with the stealth driver. (The hosted agent offers no
stealth.)

## 6. After approval

1. crawltest answers `200` with the production key (the test in section 4).
2. The hosted agent's DevTools environment gets the two variables:
   `BROWSER_WEB_BOT_AUTH_KEY='${file:…}'` and `BROWSER_WEB_BOT_AUTH_AGENT=https://ironbee.ai`.
3. The hosted bot check runs in production before and after signing. It uses the 8 sites measured
   in development, 5 of which refused the agent: Cloudflare's challenge demo, Indeed, Kohl's, Etsy
   and Hyatt.
4. The customer docs get a line on allowing IronBee on their own sites.

Site owners can then write rules for IronBee by name, by the Agent behavior, or by its detection ID
in BotBase.

## 7. Other vendors

The same key and directory serve every vendor; each needs its own application.

| Vendor | Where to register | Notes |
| --- | --- | --- |
| Akamai | the [bot agent registration](https://www.akamai.com/lp/bot-agent-registration) form | Verifies at the edge; the form asks for the agent's identity, User-Agent and public key |
| Vercel | [bots.fyi/new-bot](https://bots.fyi/new-bot) | Asks for the name, a description, a documentation URL, verification instructions and a contact. Test agents (Momentic, Stably, QA.tech) are already listed |
| AWS WAF Bot Control | No registration yet: an API for independent agents is on the roadmap | Labels `…:bot:web_bot_auth:verified`, `invalid`, `expired` and `unknown_bot`. A key it does not know is `unknown_bot`, for which AWS advises "monitor or block" |
| HUMAN | No public form found | Ask them directly |
| DataDome | Has its own form; its address is not confirmed | Blocks unauthenticated agents by default |

## 8. Before signing, and running it

Registration ties IronBee's reputation to every customer's run. Before signing is turned on:

- [ ] **Owned targets only.** Sign only for targets whose owner has verified them, with a DNS TXT
  record or a `/.well-known/` file. Other targets stay unsigned: a vendor can delist an identity
  that anyone can point at any site.
- [ ] **robots.txt.** The agent obeys the `IronBee` token. Whether it also obeys `*` rules is a
  product decision, still open.
- [ ] **The key** is given as a `${file:…}` reference, and its file is deleted once DevTools has
  started (section 4).
- [ ] **No stealth**, ever, with a signed identity.

Running it:
- **Rotation:** add the new key to the directory (two keys, two signatures), switch signing to it,
  and drop the old key some time later.
- **Monitoring:** a daily check that crawltest answers `200`, and of the directory's own signature.
- **Limits:** registration does not open every site. Since 2026-09-15, new Cloudflare domains block
  the Agent and Training behaviors on pages that show ads, by default. The owner's rule always
  wins.
- **Next:** Cloudflare is experimenting with naming an intermediary's end user in a
  `Forwarded: for="…"` header. Passing the customer's identity may be needed later.

## Sources

- Cloudflare:
  - [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)
  - [Verified bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/)
  - [BotBase](https://developers.cloudflare.com/bots/botbase/)
  - [the bots changelog](https://developers.cloudflare.com/bots/changelog/)
- Cloudflare's tools:
  - [cloudflare/web-bot-auth](https://github.com/cloudflare/web-bot-auth)
  - the [`http-signature-directory`](https://crates.io/crates/http-signature-directory) validator
- AWS:
  - [the Bot Control rule group](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html)
  - [Authenticate legitimate AI agent traffic with AWS WAF Bot Control](https://aws.amazon.com/blogs/security/authenticate-legitimate-ai-agent-traffic-with-aws-waf-bot-control/)
- Other vendors:
  - [Akamai's bot agent registration](https://www.akamai.com/lp/bot-agent-registration)
  - [Vercel's bots.fyi](https://bots.fyi/new-bot)
- IETF drafts:
  - [the key directory](https://datatracker.ietf.org/doc/html/draft-meunier-http-message-signatures-directory-03)
  - [the architecture](https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture-02)
- How DevTools signs: IronBee DevTools' `docs/browser-platform.md`, § Web Bot Auth.
