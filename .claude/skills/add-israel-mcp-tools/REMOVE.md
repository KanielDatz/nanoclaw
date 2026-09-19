# Remove Israel MCP Tools

Every step is idempotent. Apply only to groups where `/add-israel-mcp-tools`
registered one or more of `hebcal`, `boi-exchange`, `israel-railways`, or
`openbus`.

## 1. Unregister the servers

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every selected server on a given group:

```bash
ncl groups config remove-mcp-server --id <group-id> --name hebcal
ncl groups config remove-mcp-server --id <group-id> --name boi-exchange
ncl groups config remove-mcp-server --id <group-id> --name israel-railways
ncl groups config remove-mcp-server --id <group-id> --name openbus
```

Run only the lines for servers actually present on that group.

## 2. Restart and verify

```bash
ncl groups restart --id <group-id>
ncl groups config get --id <group-id>
```

Confirm none of `hebcal`, `boi-exchange`, `israel-railways`, `openbus` remain
under `mcp_servers` for that group.

No image rebuild is needed — this skill never touched `container/cli-tools.json`
or the Dockerfile.
