---
'@clawops/cli': patch
---

The site now states what clawops is in a form machines can read: schema.org `SoftwareApplication`
structured data on the landing page, an `/llms.txt` map generated from the same source as the
sitemap, canonical URLs, and per-page OpenGraph on docs pages instead of every page inheriting the
landing page's card.

Two new docs pages answer the questions assistants are actually asked: a FAQ whose headings are
the questions verbatim, carrying `FAQPage` structured data generated from the same array that
renders the page, and a comparison page that says where a compose file, a PaaS or your own
Terraform is the better answer.

None of it changes the package. It changes what an assistant says when someone asks it what
clawops is — which, until now, it could only answer from third-party listings written by people
who had not read the code.
