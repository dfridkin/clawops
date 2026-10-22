// apt-get update that outlasts a mirror caught mid-sync — shared by the cloud startup script
// (src/providers/startup.ts) and the local bootstrap (src/providers/local/bootstrap.sh.tmpl).
//
// A mirror, or a cache in front of one, can serve a package index that no longer matches the
// Release file listing it. apt-get update then fails with "Hash Sum mismatch" and exit 100, and
// a bootstrap under `set -e` stops there. Seen on the e2e nightly of 2026-10-22, against
// security.ubuntu.com: one run failed on it, and the re-run twenty minutes later did not.
// Acquire::Retries covers dropped connections, not a mismatch, so the retry is a loop. From the
// second attempt, No-Cache asks any cache on the way for a fresh copy, and the partial
// downloads are discarded.

/** The `apt_update` shell function. Define it before the first call. */
export const APT_UPDATE_FN = `apt_update() {
  local attempt
  for attempt in 1 2 3; do
    if [ "$attempt" -eq 1 ]; then
      apt-get -o Acquire::Retries=3 update -q && return 0
    else
      apt-get -o Acquire::Retries=3 -o Acquire::http::No-Cache=true update -q && return 0
    fi
    [ "$attempt" -lt 3 ] || return 1
    echo "clawops: apt-get update failed (attempt $attempt of 3); retrying in $((attempt * 30))s" >&2
    rm -rf /var/lib/apt/lists/partial/*
    sleep $((attempt * 30))
  done
}`
