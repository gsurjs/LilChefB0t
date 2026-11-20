# 🧑🏻‍🍳 LilChef — Twitch bot for roguedubz

A personality-driven Twitch chat bot built on [Twurple](https://twurple.js.org) and the
[Claude API](https://platform.claude.com/docs). Designed to complement StreamElements
rather than compete with it.

LilChef can look things up instead of guessing: ask whether the stream is live, what's
being played, or how long you've followed, and it calls the Twitch API before answering.

---

## Quick start

```bash
git clone https://github.com/gsurjs/lilchefb0t.git
cd lilchefb0t
npm install

cp .env.example .env     # fill in TWITCH_CLIENT_ID, BOT_USERNAME, CHANNEL_NAME
npm run auth             # one-time Twitch authorization
npm start
```

### 1. Register a Twitch application

At [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps):

| Field | Value |
|---|---|
| OAuth Redirect URL | `http://localhost` (required field, unused by this flow) |
| Client Type | **Public** (recommended) |

Copy the Client ID into `TWITCH_CLIENT_ID`. With a Public client you need no secret.

Device Code Flow also works with a Confidential client — in that case put the secret in
`TWITCH_CLIENT_SECRET`. Public is simply one less credential to manage.

### 2. Authorize the accounts

```bash
npm run auth
```

This uses Twitch's Device Code Flow: it prints a code, you enter it at
`twitch.tv/activate`, and the resulting tokens — **including refresh tokens** — are
written to `data/tokens.json`. The bot renews them in the background from then on.

Two properties of device-code refresh tokens worth knowing:

- **They are single-use.** Each refresh returns a *new* refresh token, and the old one
  is dead. The bot persists the replacement immediately, which is why `data/` must be
  durable and why you must never run two instances against the same token file — the
  second one would try to reuse a spent token and lock itself out.
- **They expire after 30 days of inactivity.** If the bot is offline longer than that,
  re-run `npm run auth`.

You'll be asked to authorize up to two accounts:

- **Bot account** (required) — chat, commands, moderation, raid and stream alerts.
- **Broadcaster account** (optional) — adds sub, resub, gift-sub and cheer alerts.
  Twitch only sends those to the broadcaster's own token; a moderator token cannot
  see them. Skip it and everything else still works.

Make the bot account a **moderator** in the channel so its moderation scopes apply.

#### Running in a channel you don't own

Chat identity and API authority are separate here, so you don't need every
account's login. Three roles, independently satisfiable:

| Role | Supplies | How |
|---|---|---|
| Bot | the name in chat | `BOT_CHAT_TOKEN`, or `npm run auth` |
| Broadcaster | stream online/offline events | `npm run auth` |
| Moderator | bans, timeouts, deletes, followage | `npm run auth` |

**If you can't log into the bot account**, set `BOT_CHAT_TOKEN` to any working
chat token for it (a v1 `OAUTH_TOKEN` from twitchtokengenerator works and is
read automatically as a fallback). `npm run auth` then skips that account
entirely — chat still posts under the bot's name.

**If you can't log into the broadcaster account either**, authorize your own
account as a moderator of the channel. `npm run auth` offers this explicitly.
You keep everything except stream online/offline alerts, because Twitch
authorizes those as the broadcaster and nothing substitutes.

Raid, sub, resub, gift-sub and cheer alerts are unaffected by any of this —
they arrive over chat, which needs no scopes. See [Stream events](#stream-events).

The tradeoff on a static chat token is that it can't refresh. It works until
Twitch revokes it, at which point chat stops and you'd need the bot account's
login or a fallback account. The bot validates it at startup, so that failure is
a clear boot error rather than a silent one.

### 3. Get a Claude API key

API usage is billed through a [Claude Console](https://platform.claude.com/) organization,
which is separate from a Claude.ai subscription. There are two ways to fund it:

**If you're on Max, Ultra, or Team**, your plan includes monthly API credits that cover
this bot — $100/mo on Max, $200/mo on Ultra, pooled up to $500/mo on Team. Claim them
once by linking a Console organization: on claude.ai go to **Settings → Billing → API
credits** and select the organization. No payment method required.

> Each plan links to **one** Console organization and you can't change it yourself
> later without contacting support, so link the one you intend to build in.
> Credits refresh each billing cycle and don't roll over. They don't cover Claude Code.
> Pro and Free plans aren't eligible; new subscribers can claim after 7 days.

**Otherwise**, purchase credits in the Console. New accounts get free trial credits.

Either way, create a key at
[platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) and set
`ANTHROPIC_API_KEY` in `.env`. Without it the bot still runs — the AI commands just
report themselves as unconfigured.

---

## Commands

### Everyone

| Command | Description | Usage |
|---|---|---|
| `!chefbot`, `!chef`, `!ask` | Ask LilChef anything. Knows live stream info. | `!chefbot <your question>` |
| `!uptime` | How long the stream has been live. | — |
| `!game`, `!category` | What's being played. | — |
| `!title` | The current stream title. | — |
| `!followage` | How long you (or someone else) has followed. | `!followage [@user]` |
| `!clip`, `!clips` | The most recent clip from the channel. | — |
| `!commands`, `!help` | List commands, or explain one. | `!commands [command]` |
| `!socials` | All the channel links. | — |
| `!discord` | Discord invite. | — |
| `!prime` | How to use your free Prime sub. | — |
| `!rules` | Channel rules. | — |
| `!hello`, `!hi` | Say hello. | — |
| `!lurk` / `!unlurk` | Lurk mode. | — |
| `!hug` | Give a hug. | `!hug [@user]` |
| `!love` | Love compatibility. | `!love [@user]` |
| `!8ball` | Magic 8-ball. | `!8ball <question>` |
| `!dice` | Roll a die. | `!dice [sides]` |
| `!flip` | Flip a coin. | — |
| `!rng` | Random number in a range. | `!rng [min] [max]` |
| `!vibes` / `!energy` | Vibe and energy checks. | — |
| `!quote` / `!fact` | Random quote or fun fact. | — |
| `!time` / `!botuptime` | Clock and bot uptime. | — |

### Moderators

| Command | Description | Usage |
|---|---|---|
| `!ban` | Permanently ban a user. | `!ban <@user> [reason]` |
| `!unban` | Lift a ban or timeout. | `!unban <@user>` |
| `!timeout`, `!to` | Time a user out. | `!timeout <@user> [60\|10m\|1h\|1d] [reason]` |
| `!clear` | Clear the chat. | — |
| `!so`, `!shoutout` | Shout out a streamer, with what they last played. | `!so <@user>` |
| `!echo` | Make the bot say something. | `!echo <message>` |

### Admins (`AUTHORIZED_USERS`)

| Command | Description |
|---|---|
| `!ai-toggle` | Turn the AI commands on or off. |
| `!ai-status` | Model, today's spend, cache hit rate, memory size. |
| `!ai-forget [@user]` | Clear the chat context, or one viewer's saved note. |
| `!autopost on\|off` | Periodic socials posting (live streams only). |
| `!status`, `!botinfo` | Full health report. |
| `!adminhelp` | List admin and mod commands. |
| `!restart` / `!shutdown` | Lifecycle control. |

`!commands` is generated from what's actually registered, so it can't drift out of date.

---

## The AI

`!chefbot` and name-mentions go to Claude with:

- **A rolling window** of the last ~25 chat lines, so a reply follows the conversation
  instead of answering cold.
- **Tools** backed by the Twitch API — `get_stream_status`, `get_followage`,
  `get_recent_clips`, `get_channel_links`, `remember_about_viewer`. The model calls
  these instead of inventing an answer.
- **An editable persona.** [`persona.md`](persona.md) is the bot's personality, rules
  and channel lore. Edit it and it reloads live — no redeploy, no restart. It sits in
  the cached prompt prefix, so repeat requests read it at a fraction of input cost.
- **Per-viewer notes.** If someone tells LilChef something about themselves, it can
  save a one-line note that survives restarts. Clear one with `!ai-forget @user`.

### Model and cost

| Model | Price / MTok | ~Cost per 1,000 replies |
|---|---|---|
| `claude-haiku-5-5` | $0.10 in / $0.50 out | ~$0.20 |
| `claude-sonnet-5-5` *(default)* | $2 / $10 | ~$3.80 |
| `claude-opus-5-5` | $4 / $20 | ~$7.60 |

Set `CLAUDE_MODEL` to switch. `AI_DAILY_USD_CAP` is a hard ceiling — past it, requests
are refused until UTC midnight. `!ai-status` reports actual spend and cache hit rate;
the [Console](https://platform.claude.com/usage) is the source of truth for billing.

For scale: an Ultra plan's included $200/month is roughly 52,000 Sonnet 5.5 replies, or
a million on Haiku 5.5. A Twitch channel will not come close, so the daily cap is really
an abuse guardrail rather than a budget — raise it if `!ai-status` shows you bumping it.

The default request uses `thinking: {type: "between_tools"}` and `effort: low`, which
is Sonnet 5.5's fastest configuration that still supports tools. Note that Sonnet 5.5
rejects `thinking: {type: "disabled"}` outright, and `between_tools` is rejected above
effort `high` — which is why `CLAUDE_EFFORT` is validated down to `low`/`medium`/`high`.

### Guardrails

- Model output is stripped of leading `/` and `.`, invisible characters and newlines
  before it reaches chat, and split on word boundaries under Twitch's 500-char limit.
- Chatter text is wrapped as quoted data, so "ignore your instructions" reads as
  something a viewer asked for rather than an operator instruction.
- Per-user cooldowns on `!chefbot` and on mentions, plus the daily spend cap.
- Tool loops are capped at 3 rounds, which also bounds reply latency.

---

## Stream events

Alerts come from two sources, and the split matters: **most of them need no scopes
at all**, because Twitch delivers them over chat as IRC `USERNOTICE`.

| Event | Source | Requires | Behaviour |
|---|---|---|---|
| Raid | chat | nothing | AI shoutout naming what the raider last streamed |
| Sub / resub | chat | nothing | AI thank-you, reacting to resub messages |
| Gift sub / community gift | chat | nothing | AI thank-you to the gifter |
| Cheer | chat | nothing | AI thank-you above `AI_CHEER_THRESHOLD` bits |
| Follow | EventSub | `moderator:read:followers` | Template greeting — follows arrive in bursts, so no API call per follow |
| Stream online / offline | EventSub | the **broadcaster's** token | Tracked internally |

EventSub only covers what chat cannot express. Twurple picks the token per
subscription from its `authUserId`, which for online/offline is the broadcaster —
so those are skipped when that account isn't authorized, while follows work from
a moderator's token. Skipped subscriptions are logged with the reason; they never
fail startup, and they never affect the chat-sourced alerts.

Cheers are ordinary chat messages carrying bits rather than a distinct event, so
they're handled in the message pipeline. `AI_CHEER_THRESHOLD` (default 100) keeps
every 1-bit emote in a busy chat from triggering a reaction.

First-time chatters are greeted using Twitch's own `isFirst` flag, so it fires once per
person per channel.

---

## Project layout

```
src/
  index.js          boot, message pipeline, graceful shutdown
  config.js         env loading and validation (collects every problem at once)
  store.js          atomic JSON persistence
  health.js         /healthz endpoint
  autopost.js       periodic socials, live-streams-only
  twitch/
    auth.js         RefreshingAuthProvider + token persistence
    chat.js         chat connection, threaded replies, chunking
    api.js          Helix: stream info, followage, clips, moderation
    events.js       EventSub subscriptions, scope-gated
  ai/
    client.js       Messages API + the tool loop
    tools.js        Helix-backed tool definitions and executors
    persona.js      persona.md loading and hot reload
    memory.js       rolling chat window + per-viewer notes
    budget.js       spend ledger and daily cap
    sanitize.js     output sanitizing, chunking, input wrapping
  commands/
    registry.js     dispatch, permissions, cooldowns
    fun.js social.js info.js ai.js mod.js admin.js
scripts/auth.js     one-time Device Code Flow authorization
test/               node:test suite
```

`data/` holds `tokens.json`, `budget.json` and `notes.json`. It's gitignored — these
are credentials and runtime state.

---

## Development

```bash
npm run dev     # node --watch
npm test        # 54 tests, no network access required
npm run auth    # re-authorize an account
```

The test suite stubs the Anthropic client, so it covers the request shape, the tool
loop, parallel tool results, refusals, budget enforcement and every permission and
cooldown path without spending anything or touching Twitch.

### Deployment

Node 20.19+ (22 LTS recommended). Point your host's health check at `/healthz` on
`PORT`. `!restart` exits non-zero so a process manager brings the bot back up.

**Attach a persistent volume** and point the bot's state at it. The bot resolves its
data directory in this order:

1. `DATA_DIR`, if set
2. `RAILWAY_VOLUME_MOUNT_PATH`, which Railway sets automatically for an attached volume
3. `./data` relative to the project

So on Railway, attaching a volume is enough — no extra configuration. On other hosts,
set `DATA_DIR` to the mount path.

This matters more than it looks. Device-code refresh tokens are single-use, so a
container that restarts with a stale token file will try to redeem a spent token and
lock itself out. For the same reason, **never run two instances against the same
tokens** — develop locally against `./data` and let production keep its own volume.

Since hosts like Railway have no interactive shell to run `npm run auth` in, the script
prints `BOT_REFRESH_TOKEN` and `BROADCASTER_REFRESH_TOKEN` at the end. Set those as
environment variables on the host and the first boot adopts the authorization, then
writes the rotated tokens to the volume and ignores the variables from then on.

One gotcha: host-level environment variables take precedence over `.env`, so a stale
`CLAUDE_EFFORT` or `OAUTH_TOKEN` left in a Railway dashboard will override the file.

---

## Migrating from v1

v1 ran on tmi.js with a static `OAUTH_TOKEN`. If you're upgrading:

1. `OAUTH_TOKEN`, `GROQ_API_KEY`, `GEMINI_API_KEY` and `AI_PROVIDER` are gone.
   Add `TWITCH_CLIENT_ID` and `ANTHROPIC_API_KEY`.
2. Run `npm run auth` once. This is what stops the bot dying every few hours — the
   old static token had no refresh token, so Twitch expiring it took the bot down.
3. `!ban`, `!unban`, `!timeout` and `!clear` now work. They were posting their
   commands as plain text, because Twitch removed IRC chat-command handling in
   February 2023.
4. `!echo` is now mod-only; it was a spam vector when open to everyone.
5. `!autopost-status` is folded into bare `!autopost`.

---

## License

MIT

---

*Made with ❤️ for the roguedubz streaming community*
