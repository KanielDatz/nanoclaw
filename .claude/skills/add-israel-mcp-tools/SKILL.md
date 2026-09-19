---
name: add-israel-mcp-tools
description: Add curated, credential-free Israeli public-data MCP servers (Hebrew/Jewish calendar, Bank of Israel exchange rates, Israel Railways schedules, real-time bus data) to selected NanoClaw agent groups. Use when the user wants their agent to answer Hebrew calendar/Shabbat, ILS exchange rate, train, or bus questions, or mentions the Skills-IL / agentskills.co.il directory.
---

# Add Israel MCP Tools

Wires a small, hand-picked set of read-only, keyless MCP servers — sourced from
the [Skills-IL directory](https://agentskills.co.il/he/mcp) — into one or more
NanoClaw agent groups. This is a pure runtime-config change: every server here
runs via plain `npx`, which is already present in the agent image (`node:22-slim`
base), so there is no Dockerfile edit, no image rebuild, and no source change —
just `ncl groups config add-mcp-server` calls, exactly like adding any other
third-party MCP server.

## What this adds

| Slug | Tool namespace | What it does | Package (pinned) | Key required |
|------|----------------|---------------|-------------------|---------------|
| `hebcal` | `mcp__hebcal__*` | Hebrew/Gregorian date conversion, Shabbat candle-lighting times, Jewish holidays, Torah portions, yahrzeit calculations | `@hebcal/mcp@0.10.3` | No |
| `boi-exchange` | `mcp__boi-exchange__*` | Official Bank of Israel daily exchange rates (30+ currencies vs. ILS), history, conversions | `@skills-il/boi-exchange-mcp@1.0.1` | No |
| `israel-railways` | `mcp__israel-railways__*` | Real-time Israel Railways schedules across 68 stations, platforms, delays | `@skills-il/israel-railways-mcp@1.0.1` | No |
| `openbus` | `mcp__openbus__*` | Real-time Israeli bus data (SIRI/GTFS) via the Ministry of Transport's Open Bus Stride API | `@skills-il/openbus-mcp@1.0.1` | No |

`hebcal` is maintained by the long-standing Hebcal project itself. The other
three are unofficial wrappers published by Skills-IL (the directory's own
maintainers, `yootech`) around public government/transit APIs — not packages
published by the Bank of Israel, Israel Railways, or the Ministry of Transport
directly. They're read-only, take no credentials, and (per `npm view <pkg>
scripts`) declare no install/postinstall scripts, but they are still
third-party code that will run inside the agent container — mention this to
the user before installing, and skip any they're not comfortable with.

**Deliberately excluded from this skill:**

- **Israeli banking servers** (Israeli Banking, Nudlers, IL Bank MCP, Asher
  MCP) — these use unofficial scraper libraries (`israeli-bank-scrapers`)
  against real online-banking logins. That means feeding actual bank
  credentials to third-party code, which is a materially different risk than
  the read-only public-data servers above (credential compromise, bank ToS).
  Do not wire these in as part of this skill. If the user explicitly wants
  one after being told this, treat it as its own decision — inspect the
  specific server's source first, ask which agent group (isolate it, don't
  share with a general-purpose group), and confirm they understand it's an
  unofficial scraper before adding it by hand with `ncl groups config
  add-mcp-server`.
- **`pikud-haoref` (Home Front Command alerts) and `ims-weather`** — both
  require standing up a separate self-hosted Docker/Python service outside
  NanoClaw (no npx one-liner, no hosted endpoint), so they don't fit this
  skill's zero-infra scope. Worth adding later as a follow-up if the user
  wants emergency-alert or weather tools badly enough to run that service.

## Phase 1: Pre-flight

List the groups and ask which one(s) should get these tools:

```bash
ncl groups list
```

Confirm `npx`/`node` work inside the image (should always be true on the
`node:22-slim` base — only check if something seems off):

```bash
docker run --rm nanoclaw-agent:latest node --version
```

## Phase 2: Ask which servers

Show the table above and ask the user which of the four they want (default
suggestion: all four — none require any setup or credentials). Confirm the
target agent group(s).

## Phase 3: Register

For each selected `<group-id>` and each selected server, register it with the
pinned version from the table:

```bash
ncl groups config add-mcp-server --id <group-id> --name hebcal \
  --command npx --args '["-y","@hebcal/mcp@0.10.3"]' --env '{}'

ncl groups config add-mcp-server --id <group-id> --name boi-exchange \
  --command npx --args '["-y","@skills-il/boi-exchange-mcp@1.0.1"]' --env '{}'

ncl groups config add-mcp-server --id <group-id> --name israel-railways \
  --command npx --args '["-y","@skills-il/israel-railways-mcp@1.0.1"]' --env '{}'

ncl groups config add-mcp-server --id <group-id> --name openbus \
  --command npx --args '["-y","@skills-il/openbus-mcp@1.0.1"]' --env '{}'
```

Run only the lines for servers the user actually picked. Pinning the version
in `args` (rather than bare `-y @scope/pkg`) means a compromised or broken
future release doesn't get pulled automatically on next container start —
bumping the pin is a deliberate, later decision, not an implicit one.

Restart the group once per group (not once per server) after all selected
servers are registered:

```bash
ncl groups restart --id <group-id> \
  --message "New tools installed: Hebrew calendar, ILS exchange rates, Israel Railways and/or bus schedules (whichever were selected). List your tools and confirm they're available."
```

## Phase 4: Verify

```bash
ncl groups config get --id <group-id>
```

Confirm each selected server appears under `mcp_servers` with the pinned
command/args. Then check the agent's response to the restart message — it
should see tools under the `mcp__<slug>__*` namespaces for whichever servers
were added.

Suggest a real test message per server added, e.g.:

- "What time does Shabbat start in Jerusalem this Friday?" (`hebcal`)
- "What's today's USD to ILS exchange rate?" (`boi-exchange`)
- "When's the next train from Tel Aviv Savidor to Haifa Hof HaCarmel?" (`israel-railways`)
- "What buses stop near Dizengoff Center in the next 15 minutes?" (`openbus`)

## Troubleshooting

- **Tools don't appear after restart**: confirm the group actually restarted
  (`ncl groups config get` shows the server, but the container needs the
  restart to pick it up) — re-run the `ncl groups restart` command.
- **`npx` fails / times out inside the container**: the container needs
  outbound network access to the npm registry; check the container's egress
  policy if one is configured.
- **Server returns errors for a specific query**: these hit live third-party
  APIs (Bank of Israel, Israel Railways, Open Bus Stride) — an outage or API
  shape change upstream is a Skills-IL/Hebcal-side issue, not a NanoClaw one.
  Check the linked GitHub repo for open issues before assuming it's local.

## Removal

See [REMOVE.md](REMOVE.md).

## References

- [Skills-IL MCP directory](https://agentskills.co.il/he/mcp)
- [Hebcal MCP](https://github.com/hebcal/hebcal-mcp)
- [Skills-IL MCP servers monorepo](https://github.com/skills-il/mcps)
