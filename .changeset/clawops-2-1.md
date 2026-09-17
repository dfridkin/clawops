---
"@clawops/cli": patch
---

**The setup wizard writes model configuration OpenClaw accepts**, and installs the plugin your
chosen provider needs.

**Amazon Bedrock works.** clawops sets the transport Bedrock needs and resolves an inference
profile against your deployment region, preferring your own geography, and records the concrete
profile in the plan. This needs `bedrock:ListInferenceProfiles` on the identity running clawops.

**`clawops setup` checks your cloud account is ready before provisioning anything**, and
offers to fix what it safely can — enabling an API, creating a state bucket — naming the exact
change first. A bucket clawops creates has versioning enabled. `clawops doctor` reports the
same checks without offering to change anything.

**`clawops doctor` validates cloud credentials.**

**Cloud stacks are deployed with the ingress rules from the plan.**

**Documentation:** the GCP guide names the credential source clawops actually reads and
describes 2.0 firewall behaviour; the smoke-test plan covers 2.0, and `pnpm test:cloud` runs it
against a real deployment and destroys it afterwards.
