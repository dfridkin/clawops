// Which npm dist-tags a release should set.
//
// The 1.x line publishes under `legacy` so a maintenance patch cannot take `latest` back
// from 2.x. That reasoning only holds once 2.x has shipped. Before it has, `latest` is a 1.x
// version, and publishing 1.x under `legacy` alone leaves `npm install -g @clawops/cli` —
// the command in the README — serving the *previous* 1.x release.
//
// That is what happened to 1.7.8: published as `legacy: 1.7.8` while `latest` stayed 1.7.7,
// so the release that added authentication to the MCP HTTP server was not what a fresh
// install got.
//
// Only ONE tag can be set, because only the publish call is authenticated. npm's trusted
// publishing exchanges an OIDC token inside `npm publish` and does not leave credentials
// behind, so a follow-up `npm dist-tag add` gets:
//
//   npm error code E401
//   npm error Unable to authenticate, your authentication token seems to be invalid.
//
// Measured on the 1.7.9 release. So the choice is which single tag the publish takes, and
// pre-2.0 that has to be `latest`: a stale `latest` is served to every default install,
// while a stale `legacy` only reaches someone who pinned it deliberately.
//
// When 2.0.0 ships, `legacy` needs setting once, by hand, to the final 1.x release. That is
// a one-time step at a boundary that is already a manual event.
//
// Pure so it can be tested; the shell script does the I/O.

/** The major version number of a SemVer string, or undefined when it is not one. */
export function majorOf(version) {
  const match = /^(\d+)\./.exec(String(version ?? '').trim())
  return match ? Number(match[1]) : undefined
}

/**
 * @param {object} input
 * @param {string} input.branch          Branch being released from.
 * @param {string} input.version         Version about to be published.
 * @param {string|undefined} input.currentLatest  What the registry serves as `latest` now.
 * @returns {{ publishTag: string|undefined, alsoTag: string[] , reason: string }}
 */
export function planDistTags({ branch, version, currentLatest }) {
  if (branch !== '1.x') {
    return {
      publishTag: undefined,
      alsoTag: [],
      reason: 'release line: changesets default (latest)',
    }
  }

  const latestMajor = majorOf(currentLatest)

  // `latest` is unreadable — a network failure, a package that does not exist yet. Publish
  // under `legacy` only. Leaving `latest` alone is the recoverable mistake; moving it on a
  // guess is not.
  if (latestMajor === undefined) {
    return {
      publishTag: 'legacy',
      alsoTag: [],
      reason: `could not read the current latest (${JSON.stringify(currentLatest)}); leaving it alone`,
    }
  }

  // Strictly greater: the same major is the same line, and a newer patch on it should take
  // `latest`. `>=` here would treat 1.7.9 as unable to supersede 1.7.8.
  if (latestMajor > majorOf(version)) {
    return {
      publishTag: 'legacy',
      alsoTag: [],
      reason: `latest is ${currentLatest}, from a newer line — 1.x must not take it back`,
    }
  }

  // No tag: changesets' default is `latest`, which is the one that matters here. Asking for
  // `legacy` as well would need a second authenticated call, and there is not one.
  return {
    publishTag: undefined,
    alsoTag: [],
    reason:
      `latest is ${currentLatest}, still on this line — publishing to latest so a fresh ` +
      `install gets this release. \`legacy\` is set by hand once, when 2.0.0 ships.`,
  }
}
