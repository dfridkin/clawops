---
'@clawops/cli': patch
---

**The VM size clawops asks for on Azure may not be offered to your subscription.**

Azure gates SKU families per subscription and region. The subscription this was first run
against was offered **no B-series size at all** in `eastus` — which is every non-GPU size
clawops names (`Standard_B1s`, `B2s`, `B4ms`, `B8ms`). The deploy failed with:

```
Status=409 Code="SkuNotAvailable" … 'Standard_B2s' is currently not available in location 'eastus'
```

after the virtual network, NSG, public IP and NIC had been created.

`clawops doctor` checks the default size against what the subscription is actually offered, and
names alternatives of a similar shape:

```
✗  Standard_B2s is available in eastus
   … Available instead: Standard_D2ads_v7, Standard_D2als_v7, Standard_D2as_v7 —
   pass one with `clawops plan --instance-type <size>`
```

The size map is unchanged on purpose: availability is per-subscription, so a map that works for
one account breaks another. clawops names what your account can have instead of guessing.
