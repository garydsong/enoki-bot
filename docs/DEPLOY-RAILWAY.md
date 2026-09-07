# Deploying Enoki to Railway

From a GitHub repo to a bot that stays online, in about fifteen minutes.

Railway builds the `Dockerfile` in this repo, so the thing that runs in the
cloud is the thing you tested locally. Everything below is done in a browser
except step 0.

**Before you start**, know the two things that make this bot different from a
web app, because they shape several steps:

- **It is a long-running gateway process, not a web server.** It holds a
  websocket to Discord. Anything that scales to zero, sleeps when idle, or runs
  per-request (Vercel, Netlify, Lambda, Cloudflare Workers) cannot host it.
- **Exactly one copy may run at a time.** Two instances means two gateway
  connections, so every message is seen twice, and the message cooldown lives in
  each process's own memory — so members would earn double XP. Step 6 is about
  making sure that never happens, including during a deploy.

---

## 0. Push the current code

```bash
git add -A
git commit -m "Deployment fixes"
git push
```

Railway deploys whatever is on your default branch. If your GitHub repo is
behind your local machine, it will build old code and you will spend an hour
confused.

---

## 1. Create the project

1. Go to <https://railway.com> and sign in **with GitHub**. Signing in this way
   is what lets Railway see your repositories.
2. **New Project → Deploy from GitHub repo**.
3. Pick your Enoki repository. If it is not listed, click **Configure GitHub
   App** and grant access to that specific repo.

Railway starts a build immediately. **It will fail, and that is expected** —
there is no database and no token yet. Let it fail; do not debug it.

---

## 2. Add the database

1. In the project canvas, click **New → Database → Add PostgreSQL**.
2. Wait for it to finish provisioning (about thirty seconds).

Railway creates a `DATABASE_URL` on the Postgres service. You do **not** copy
that value anywhere — step 3 references it, which is better than copying,
because a reference survives Railway rotating the credentials.

---

## 3. Set the variables

Click the **bot service** (not the database) → **Variables** tab. Add these.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — type it exactly, braces included |
| `DISCORD_TOKEN` | your bot token from the Developer Portal |
| `DISCORD_APPLICATION_ID` | `1545460676426993754` |
| `NODE_ENV` | `production` |
| `LOG_PRETTY` | `false` |
| `ENABLE_MESSAGE_CONTENT` | `true` |

`${{Postgres.DATABASE_URL}}` is Railway's reference syntax. If your database
service has a different name in the canvas, use that name instead of
`Postgres`. Railway autocompletes it as you type — take the suggestion rather
than typing it from memory.

**Do not set `DISCORD_DEV_GUILD_ID` in production.** It registers the commands
to one server only. Leaving it unset registers them globally, which is what you
want, and which takes up to an hour to propagate the first time.

**Do not set `HTTP_PORT`.** Railway injects `PORT`, and the bot now reads that
as a fallback. Setting `HTTP_PORT` yourself overrides the platform and breaks
the health check.

### About the token

Your bot token is a password. Railway variables are encrypted at rest and
hidden in the UI after saving, which is the right place for it. Two rules:

- Never commit it. `.env` is gitignored; keep it that way.
- If it has ever been pasted into a chat, a screenshot, a support ticket or a
  public repo, **reset it** in the Developer Portal first and deploy the new
  one. A leaked token lets anyone act as your bot in every server it is in.

---

## 4. Deploy and watch the logs

Railway redeploys automatically when variables change. Open the bot service →
**Deployments** → click the running one → **View logs**.

A healthy first boot looks like this, in this order:

```
{"msg":"starting", ...}
{"msg":"composed modules","modules":["leveling"], ...}
{"msg":"applying migration","migration":"core:0001_core.sql"}
{"msg":"applying migration","migration":"core:0002_job_run_cancelling.sql"}
{"msg":"applying migration","migration":"leveling:0001_leveling.sql"}
... seven more ...
{"msg":"migrations up to date","applied":9,"skipped":0}
{"msg":"registered application commands","count":5}
{"msg":"gateway ready", ...}
```

**`"applied":9` is the number that matters.** The migrations are read from disk
at boot; a build that failed to copy them would report a smaller number, start
anyway, and then fail every query. If you see fewer than nine on a fresh
database, stop and check the build logs rather than continuing.

If boot fails, the error message names the cause. The three you might actually
hit:

- **`Used disallowed intents`** — the Server Members and Message Content
  intents are not enabled in the Developer Portal → your app → Bot. Enable them
  and redeploy.
- **`Discord refused to register slash commands (403)`** — the application ID
  does not match the token, or the bot was invited without the
  `applications.commands` scope. Re-invite using the URL in the README.
- **`ECONNREFUSED` / database errors** — `DATABASE_URL` is not resolving. Check
  it reads `${{Postgres.DATABASE_URL}}` and that the service name matches.

---

## 5. Point the health check at the bot

Bot service → **Settings** → **Deploy** → **Healthcheck Path**: `/healthz`.

This is what makes Railway's zero-downtime deploy work: it waits for the new
container to answer before it stops the old one.

Use `/healthz`, not `/readyz`. `/healthz` means "the process is alive";
`/readyz` also requires the gateway and the database, and a brief database blip
would otherwise make Railway kill and restart a perfectly healthy bot. That
distinction is deliberate — see `docs/RUNBOOK.md` §1.

---

## 6. Make sure only one copy ever runs

This is the step people skip and regret.

1. Bot service → **Settings** → **Deploy**.
2. **Replicas: 1.** Never raise this. There is no sharding, and two instances
   award XP twice.
3. **Restart Policy: On Failure**, with a retry limit of around 10.
4. Set **Serverless / App Sleeping** to **off** if your plan exposes it. A
   sleeping bot is an offline bot — nothing makes an HTTP request to wake it,
   because Discord talks over a websocket.

### The deploy overlap

Railway's default is an overlapping deploy: the new container starts and
becomes healthy before the old one stops. For a web app that is exactly right.
For this bot it means a few seconds where two processes hold gateway
connections and both award XP.

Nothing is corrupted by that — the XP write is atomic, voice crediting is
watermarked, and Highlights are claimed before posting — but a handful of
messages during the overlap can be counted twice. If you would rather not have
even that, set the deploy strategy to **Recreate** (stop the old container
first) under Settings → Deploy. You trade a few seconds of downtime for exact
accounting. For most servers the overlap is fine and the default is better.

---

## 7. Turn the bot on

Commands take up to an hour to appear the first time they are registered
globally. Once they do, in your server:

```
/level config set key:enabled value:on
```

Then the things that ship off by default:

```
/level config set key:voice.enabled value:on
/level config set key:reaction_receive.enabled value:on
/level config set key:cards.enabled value:on
/level config set key:periods.timezone value:America/New_York
```

Finish with `/level debug health`, which reports everything wrong with the
server's setup — a reward role above the bot, a channel it cannot post in, a
job that has not run.

---

## 8. Backups

Railway's Postgres takes automatic daily backups on paid plans — check
**Postgres service → Backups** and confirm you can see them. Automatic backups
you have never looked at are a guess, not a plan.

Take your own copy before anything risky (a schema change, an `/xp import`, a
`reset-server`):

```bash
railway login
railway link            # choose the project
railway run pg_dump --format=custom --no-owner > enoki-$(date +%F).dump
```

`railway run` executes the command locally with the service's environment
injected, so `pg_dump` reads `DATABASE_URL` without you handling it. Restoring
is `pg_restore`; `docs/RUNBOOK.md` §4 has the full drill, and it was actually
performed rather than merely written.

---

## 9. Afterwards

**Deploying a change** is `git push`. Railway builds and swaps automatically.

**Watching it** — Railway's Observability tab plots CPU, memory and restarts. A
climbing restart count is the signal that matters: it means the process is
crashing and being restarted, which the bot's own logs will explain.

**Metrics** — the bot exposes Prometheus format at `/metrics` on the same port.
Railway does not scrape it, but `railway run curl localhost:$PORT/metrics`
works, and `docs/RUNBOOK.md` §8 lists what is worth alerting on.

**Cost** — the bot idles at roughly 150–250 MB of memory, spiking while
rendering a card. With the database, expect around $5/month on Railway's Hobby
plan. If that grows unexpectedly, it is almost always the database, not the
bot.

---

## What this does not cover

**Scaling past one process.** Discord requires sharding beyond ~2,500 guilds,
and this bot does not shard. It also assumes one process for the message
cooldown cache. If Enoki ever needs to run in more than one place, that is a
real design change — the cooldown store becomes shared state — not a
configuration change.

**A second environment.** If you want staging, duplicate the project against a
second Discord application with its own token and its own database. Never point
two environments at one database: they would fight over the same guild
configuration and both try to post the same Highlights.
