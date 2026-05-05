# /add-provider

Scaffold a new cloud provider adapter.

## Steps

1. **Validate the provider name** — must be one of `aws`, `gcp`, `azure`, `local`.
   Check `spec/providers.schema.json → properties.name.enum`.

2. **Run the scaffold script:**
   ```
   tsx scripts/scaffold-provider.ts <name>
   ```
   This creates `src/providers/<name>/index.ts` with the full `ProviderAdapter` interface stubbed out.

3. **Implement the adapter** — fill in each method:
   - `program` — the Pulumi inline program (see `src/pulumi/CLAUDE.md`)
   - `getConnectionInfo` — extract SSH host/port/user from stack outputs
   - `normalizeInstanceType` — map `InstanceAlias` to provider-native type
   - `defaultRegion` — sensible default for this provider
   - `stateBackendUrl` — `s3://`, `gs://`, `azblob://`, or `file://`
   - `validateConfig` — check required env vars, return errors (not throw)

4. **Register the adapter** in `src/providers/index.ts`:
   ```typescript
   import myAdapter from './<name>'
   registerProvider(myAdapter)
   ```

5. **Add provider docs:** `docs/providers/<name>.md` — follow `docs/providers/_template.md`.

6. **Write tests** in `tests/providers/<name>/`:
   - Use `@aws-sdk/client-mock` or `nock` — never call real APIs
   - For Pulumi components use `pulumi.runtime.setMocks()`

7. **Run `pnpm typecheck && pnpm test`** — both must pass.

## Constraints

- Per `.claude/rules/providers.md`: no credentials in code (R6), deny-all default firewall (N10).
- Per `spec/providers.schema.json`: all required fields must be implemented.
