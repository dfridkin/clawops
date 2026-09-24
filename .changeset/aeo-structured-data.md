---
'@clawops/cli': patch
---

The site now states what clawops is in a form machines can read: schema.org `SoftwareApplication`
structured data on the landing page, an `/llms.txt` map generated from the same source as the
sitemap, canonical URLs, and per-page OpenGraph on docs pages instead of every page inheriting the
landing page's card.

None of it changes the package. It changes what an assistant says when someone asks it what
clawops is — which, until now, it could only answer from third-party listings written by people
who had not read the code.
