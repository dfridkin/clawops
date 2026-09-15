---
'@clawops/cli': patch
---

**`clawops doctor --instance-type <size>`**, so account checks ask about the size you are
actually deploying.

Azure offers SKU families per subscription, so "is this size available here" can only be
answered about a specific size. The check used the provider's default, which is right for a
plain `clawops up` and wrong for anyone passing `--instance-type`: a healthy deployment using an
available size was reported as broken, because a size it does not use is unavailable.

The cloud end-to-end script also preflighted the wrong cloud. `clawops doctor` with no arguments
checks whichever provider the default stack uses, and the default moves — deleting the script's
own throwaway stack hands it to whichever stack is left. So the second Azure run preflighted
GCP, passed, and deployed without a single Azure check having run. It uses `--provider` now.
