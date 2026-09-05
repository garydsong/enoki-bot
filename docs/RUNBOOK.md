# Enoki — Operations Runbook

Everything needed to run, upgrade, back up and repair a self-hosted Enoki.
Written to be followed at 2am by someone who did not write it.

---

## 1. Deploy

```bash
cp .env.example .env          # fill in DISCORD_TOKEN and DISCORD_APPLICATION_ID
docker compose up -d
docker compose logs -f bot
```

A healthy start logs, in this order: `starting` → `composed modules` →
`migrations up to date` → `registered commands` (or `command set unchanged`) →
`gateway ready` → `guilds reconciled` → `started`.

Migrations run **before** the gateway connects, and a failed migration aborts
boot. That is deliberate: a bot running against a schema it does not understand
writes corrupt data quietly, and refusing to start is the cheap outcome.

### Health

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /healthz` | the process is alive | restart policy / liveness probe |
| `GET /readyz` | gateway connected **and** database answering | load balancer / readiness probe |
| `GET /metrics` | Prometheus exposition | scraping |

Never restart on `/readyz` alone. A database blip should not cost you the
in-memory cooldowns and the voice-session working set; conflating liveness and
readiness turns a ten-second blip into a restart loop.

---

## 2. Upgrade

```bash
git pull
docker compose build bot
docker compose up -d bot      # migrations run automatically on boot
```

Migrations are forward-only and checksummed. **Never edit an applied migration**
— boot will refuse with `migration <id> has changed since it was applied`, which
is the guard working. Add a new numbered file instead.

Rolling back the *code* is safe as long as the schema is compatible. Rolling
back the *schema* is not automated on purpose: a down-migration that drops a
column loses XP, and the one that eventually runs by accident at 2am is the
reason. To undo a schema change, write a new forward migration.

---

## 3. Back up

Enoki keeps everything in Postgres. There is no other state worth saving —
cooldowns and caches are in memory by design and are worthless after a minute.

```bash
docker compose --profile backup run --rm backup
```

That writes a timestamped custom-format dump into `./backups`. For a manual one:

```bash
docker compose exec -T postgres pg_dump -U enoki --format=custom enoki > enoki-$(date +%F).dump
```

Keep at least: the last 7 daily dumps, and one monthly. A dump of a server with
a few thousand members is measured in megabytes.

---

## 4. Restore — drill performed 2026-09-05

**This procedure was actually executed, not merely written.** A database was
seeded through the application's own repositories, dumped, dropped, restored,
and the bot was started against the restored copy.

```bash
# 1. Stop the bot so nothing writes during the restore.
docker compose stop bot

# 2. Recreate an empty database.
docker compose exec postgres dropdb -U enoki --if-exists enoki
docker compose exec postgres createdb -U enoki enoki

# 3. Restore.
docker compose exec -T postgres pg_restore -U enoki --dbname=enoki --no-owner < enoki-2026-09-05.dump

# 4. Start. Migrations must report applied:0.
docker compose up -d bot
docker compose logs bot | grep migrations
```

Observed in the drill:

```
seeded
dump bytes: 41180
--- restored ---
4242 xp, level 7, drill-user
core:0001_core.sql
leveling:0001_leveling.sql
leveling:0002_reward_unassignable.sql
leveling:0003_voice_session.sql
leveling enabled: true
```

and on boot against the restored database:

```
"applied":0  "skipped":4  "msg":"migrations up to date"
```

**`applied:0` is the check that matters.** A non-zero count after a restore
means the dump predates a migration, and the bot has just altered a schema you
have not verified. Stop and investigate rather than letting it run.

---

## 5. Rotate the bot token

1. Discord Developer Portal → your app → **Bot** → **Reset Token**.
2. Put the new value in `.env` as `DISCORD_TOKEN`.
3. `docker compose up -d bot`.

The old token stops working the moment it is reset, so there is a few seconds of
downtime. Nothing is lost: voice sessions are flushed on shutdown and resumed on
the next start.

If a token ever appears in a log, a screenshot, or a chat message, reset it —
possession is the whole of authentication.

---

## 6. Common incidents

### "Used disallowed intents" at startup

Privileged intents are not enabled. Developer Portal → your app → **Bot** →
enable **Server Members Intent** (required) and **Message Content Intent**
(optional). The bot names the exact toggles in the error it prints.

### Commands do not appear in Discord

- With `DISCORD_DEV_GUILD_ID` set they register to that one server instantly.
  Blank means global, which takes up to an hour to propagate.
- The bot skips re-uploading an unchanged command set. To force one:
  `DELETE FROM platform_kv WHERE key LIKE 'commands:%';` then restart.
- A 403 at registration usually means the bot was invited without the
  `applications.commands` scope. Re-invite with the URL in the README.

### Nobody is earning XP

Run `/level debug why` in the channel in question. It executes the real pipeline
in collect-all mode and names **every** gate that said no. The usual answers are
that leveling is off, a `restrict_only` rule was set up months ago and forgotten,
or the member is on cooldown.

### Reward roles are not being granted

`/level debug rewards @member` shows the desired set, the diff, and the specific
blocker. Almost always one of:

- the bot's role sits **below** the reward role → move it up in
  Server Settings → Roles;
- missing **Manage Roles**;
- the role was deleted.

Broken rules are kept and skipped, not discarded, and an hourly job re-checks
them — fix the cause and the reward starts working again on its own within the
hour.

### Voice XP stopped

`/level debug health` reports the last success of every job. If
`leveling:voice-tick` is stale, voice XP has silently ceased — that is the
failure mode the `job_run` bookkeeping exists to make visible. Check the logs
for `job failed`, then restart the bot; sessions are reconciled against
Discord's own voice states on the next start.

### The database went away

`/readyz` returns 503 and the logs show `idle postgres client error`. The bot
stays up on purpose. Gateway events during the outage are logged and dropped —
message XP for those minutes is lost, which is correct, and voice sessions
resume without crediting the gap. Nothing needs doing beyond bringing Postgres
back.

### The bot will not shut down

Shutdown has a 10-second hard deadline and then exits regardless, so this should
not happen. If it does, `docker compose kill bot` is safe: open voice sessions
are closed by the orphan sweep on the next start, at their last proven-present
moment.

---

## 7. What is kept, and for how long

Retention only ever removes **operational** data. Member XP, statistics and
configuration are never aged out by anything.

| Data | Default | Setting |
|---|---|---|
| Audit entries | 90 days | `RETENTION_AUDIT_DAYS` |
| Closed voice sessions | 30 days | `RETENTION_VOICE_SESSION_DAYS` |
| Weekly/monthly XP buckets | 400 days | `RETENTION_PERIOD_XP_DAYS` |

Deletion runs daily in bounded batches so it never holds long locks on
`audit_log`, which `/xp` writes to synchronously.

Removing the bot from a server does **not** delete anything — the guild is
soft-deleted so a rejoin restores everything.

---

## 8. Metrics worth alerting on

| Metric | Alert when |
|---|---|
| `enoki_job_runs_total{job="leveling:voice-tick",outcome="failed"}` | increasing |
| `enoki_commands_total{outcome="error"}` | rate rises sharply |
| `enoki_command_duration_ms` | p95 approaches 3000ms (Discord's deadline) |
| `enoki_discord_errors_total` | sustained non-zero |
| `enoki_guilds` | drops unexpectedly |

Every label here is drawn from a closed set. Do not add a `guild_id` label — it
creates one time series per guild and will eventually exhaust both this process
and your Prometheus.
