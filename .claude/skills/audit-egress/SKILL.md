# /audit-egress

Audit all outbound network calls in a source file or module.

## Steps

1. **Scan for outbound calls** in the target file(s):
   - `fetch(`, `axios.`, `http.request(`, `https.request(`
   - `ssh2` `connect(` calls
   - AWS SDK, GCP SDK, Azure SDK client instantiation
   - Pulumi provider resource creation

2. **For each call, verify:**
   - It goes through an AbortSignal (R13)
   - Credentials come from `process.env`, not function arguments (R6)
   - The call is documented in the file's module header

3. **Check MCP tools** additionally:
   - Does the tool set `openWorldHint: true` if it makes external calls?
   - Is the output trimmed to 8KB before returning (R14)?

4. **Report findings** as a structured list:
   ```
   [PASS] src/transport/ssh.ts:42 — AbortSignal present ✓
   [FAIL] src/providers/aws/index.ts:17 — missing AbortSignal
   ```

## When to run

- Before submitting a PR that adds network calls
- When the `/add-provider` or `/mcp-tool` skill is used
- During security review
