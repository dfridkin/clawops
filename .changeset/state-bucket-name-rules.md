---
'@clawops/cli': patch
---

Cloud Storage bucket names containing dots may be up to 222 characters, with each dot-separated
part capped at 63. clawops was rejecting them at 63.
