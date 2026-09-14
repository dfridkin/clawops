---
'@clawops/cli': patch
---

**`clawops plan` named an instance size no cloud has.**

The plan wrote the clawops size name — `micro`, `small`, `medium`, `large`, `gpu` — straight
into `spec.instanceType`, and apply handed it to the provider verbatim:

```
Error 400: Invalid value for field 'resource.machineType':
'projects/…/machineTypes/small'. Machine type with name 'small' does not exist in zone 'us-central1-a'.
```

— after the network, subnet, address and firewall rule had already been created. The same on
AWS, where the type is `t3.small`, and on Azure, where it is `Standard_B2s`.

Every adapter has carried `normalizeInstanceType` from the start and `clawops up` calls it.
`generatePlan` did not, though `spec/deploy-plan.schema.json` describes the field as a
*"provider-native instance type. Adapter normalizes from clawops alias before plan emission"*.

It does now, so the plan records what the cloud will actually be asked for. A value that is not
one of the five sizes is still passed through — an operator naming a real machine type knows
their cloud's catalogue better than our table does — with a note on stderr saying so.
