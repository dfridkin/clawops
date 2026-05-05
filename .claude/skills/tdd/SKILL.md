# /tdd

Test-driven development workflow for clawops.

## Steps

1. **Write the test first** in the appropriate `tests/` subdirectory.

2. **Run** `pnpm test:changed` to confirm the test fails (red).

3. **Implement the minimum code** to make the test pass.

4. **Run** `pnpm test:changed` again to confirm green.

5. **Refactor** if needed, keeping tests green.

## Test placement

| Code | Test location |
|---|---|
| `src/providers/<name>/` | `tests/providers/<name>/` |
| `src/pulumi/components/` | `tests/pulumi/components.test.ts` |
| `src/mcp/tools/` | `tests/mcp/tools.test.ts` |
| `src/plan/` | `tests/plan/schema.test.ts` |
| `src/transport/` | `tests/transport/` |

## Mocking rules

- Cloud SDKs: `@aws-sdk/client-mock` or `nock`. **Never call real cloud APIs in unit tests.**
- Pulumi components: `pulumi.runtime.setMocks()`.
- SSH: mock at the `ssh2` level or use `linuxserver/openssh-server` for integration tests.

## Coverage targets

- Overall: 70% line coverage
- `src/plan/validate.ts`: 100%
- `src/providers/types.ts` interface adherence: 90%
