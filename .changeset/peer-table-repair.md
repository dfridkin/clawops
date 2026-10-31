---
"@clawops/cli": patch
---

A fleet member's firewall table now puts itself back. The host agent reads the table back every 30 s. If something removed or changed it (`nft flush ruleset`, a failed load at boot, another firewall tool), the agent restores the table install wrote and audits the repair as `peer_table_repair`. That matters most on a host that only serves peers: it needs no `--strict`, so the table is the only thing keeping its containers from querying peers as that host. `clawops doctor` now has a **Fleet firewall** check on every fleet member. It fails while the table is not the one install loaded, and warns when the boot unit that loads it is disabled.
