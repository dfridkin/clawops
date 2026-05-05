# src/pulumi — Pulumi Automation API layer

## URN convention

All Pulumi resources use: `clawops:<category>:<Name>`

Categories:
- `infra` — Server, HostBootstrap
- `net`   — Firewall, Tunnel
- `app`   — Gateway, GatewayInit
- `build` — Image
- `state` — Secrets, ConfigStore

## Components

Each component in `components/` is a `pulumi.ComponentResource` subclass.
Constructor signature: `(name: string, args: XxxArgs, opts?: ComponentResourceOptions)`.
All args use `pulumi.Input<T>`. All public outputs use `pulumi.Output<T>`.
Call `this.registerOutputs(...)` at the end of the constructor.

## Testing

Use `pulumi.runtime.setMocks()` — see `tests/pulumi/components.test.ts`.
Type tags must be exact: `aws:ec2/instance:Instance`, not `aws:ec2:Instance`.

## pnpm hoisting

`@pulumi/pulumi` is hoisted in `.npmrc`. See `docs/decisions/0003-pulumi-pnpm-hoisting.md`.
