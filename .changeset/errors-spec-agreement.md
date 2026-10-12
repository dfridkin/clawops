---
'@clawops/cli': patch
---

**The MCP audit log redacts credential arguments the spec already listed.** `spec/errors.yaml`
names `GOOGLE_APPLICATION_CREDENTIALS` as sensitive, but the audit log only redacted names
containing `token`, `secret`, `key`, `password`, `connectionString` or `authorization`, so an
argument with that name was written in the clear. Names containing `credential` are now redacted.

The spec also claimed that `pnpm gen:schemas` generated the error classes from it and that CI
checked them. Neither was true (#185). A test now fails if the spec and the code disagree on an
error class, its exit code, or a redaction pattern.
