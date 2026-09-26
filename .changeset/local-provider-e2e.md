---
'@clawops/cli': patch
---

**The local provider's bootstrap is now actually tested.** Its e2e suite mocked
`localBootstrap` to return exit 0 and asserted on the state handling around it — the header said
why, and the reason was that the SSH target had no `apt-get` and no init, so the script could not
have run. Every claim the bootstrap makes went unverified, including two that have since caused a
live failure: the state directory must be owned by uid 1000 numerically, and the gateway token
must survive a re-run.

It now runs against a container with systemd as PID 1, which installs Docker from the apt repo,
pulls the OpenClaw image, writes the systemd unit and waits for the gateway to answer — the real
script, on a real host, with the result inspected on that host. Opt-in
(`pnpm test:e2e:local`), nightly, and on any pull request labelled `e2e`.

Verified by mutation rather than by passing: changing the chown to 1001 makes four tests fail with
the gateway restart-looping, and removing the token guard fails exactly the re-run test. The
previous suite would have passed both.
