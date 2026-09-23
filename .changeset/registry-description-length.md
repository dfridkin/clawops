---
'@clawops/cli': patch
---

The description is back inside the MCP registry's 100-character limit. The one 2.1.0 shipped was
110, so the registry refused it with a 422 — after npm had already published, because that step
runs first. A test now asserts the limit, so the next overrun fails in seconds rather than at the
end of a release.
