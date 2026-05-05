# src/providers — Provider adapters

Each provider lives in its own subdirectory and exports a default `ProviderAdapter`.
The interface is GENERATED from `spec/providers.schema.json` into `types.ts`.

## Adding a provider

Use the `/add-provider` skill: it scaffolds the directory, wires up the adapter,
and ensures the schema is satisfied.

## Conventions

- `src/providers/<name>/index.ts` exports `default: ProviderAdapter`
- All credential reads via `process.env` (R6 — no credentials in config)
- `validateConfig()` must check required env vars at startup and return errors,
  not throw. Throw only at the CLI boundary.
- State backend URL scheme must match `spec/providers.schema.json → stateBackend.scheme`.
- Pulumi resource type URNs: `clawops:<category>:<Name>` where category ∈ {infra, build, net, app, state}.
