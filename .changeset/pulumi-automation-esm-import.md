---
'@clawops/cli': patch
---

Every cloud command failed on startup when clawops was installed from npm:

```
Directory import '.../node_modules/@pulumi/pulumi/automation' is not supported
resolving ES modules imported from '.../@clawops/cli/dist/chunk-*.js'
```

`@pulumi/pulumi` publishes no `exports` map, so `@pulumi/pulumi/automation` resolves only under
CommonJS rules. The three imports of it now name `@pulumi/pulumi/automation/index.js`.

This affected 2.0.1 only, and only an installed copy — `doctor --provider`, `plan`, `apply`,
`up` and `destroy` all stopped before doing anything. `clawops --version` worked, which is why
it was missed. `pnpm verify:pack` now installs the packed tarball and runs it, in CI on every
pull request.
