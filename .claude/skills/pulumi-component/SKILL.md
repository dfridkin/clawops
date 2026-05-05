# /pulumi-component

Add a new Pulumi ComponentResource to `src/pulumi/components/`.

## Steps

1. **Choose a category** from the URN convention: `infra`, `build`, `net`, `app`, `state`.

2. **Create `src/pulumi/components/<name>.ts`** with this pattern:
   ```typescript
   import * as pulumi from '@pulumi/pulumi'

   export interface MyComponentArgs {
     // All inputs are pulumi.Input<T>
   }

   export class MyComponent extends pulumi.ComponentResource {
     public readonly myOutput: pulumi.Output<string>

     constructor(name: string, args: MyComponentArgs, opts?: pulumi.ComponentResourceOptions) {
       super('clawops:<category>:MyComponent', name, {}, opts)

       // Create child resources with { parent: this }

       this.myOutput = pulumi.output('...')
       this.registerOutputs({ myOutput: this.myOutput })
     }
   }
   ```

3. **Export from the component file.**

4. **Wire into the provider adapter's `program` function.**

5. **Write tests** in `tests/pulumi/`:
   - Use `pulumi.runtime.setMocks()` (see `src/pulumi/CLAUDE.md`)
   - Type tags must be exact: `aws:ec2/instance:Instance` not `aws:ec2:Instance`

6. **Run `pnpm typecheck && pnpm test`.**

## Rules

- Per `.claude/rules/pulumi.md`: all inputs `pulumi.Input<T>`, all outputs `pulumi.Output<T>`.
- Call `this.registerOutputs(...)` at the end of the constructor.
- No credentials in Automation API `envVars` (R6).
