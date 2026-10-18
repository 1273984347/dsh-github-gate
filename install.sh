#!/usr/bin/env sh
# Download and verify a dsh-github-gate release, then print the install step.
#
# This installer does the two things it can do honestly: fetch the published
# tarball and verify it against the sha256 GitHub publishes for that asset. It does
# NOT install, because installing rewrites the Harness profile and the tool that
# owns that (`plugin_manager install_bundle`) asks for approval — that is the point
# at which downloaded code is allowed to run.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/1273984347/dsh-github-gate/main/install.sh | sh
#   VERSION=v2.0.0 PREFIX=/tmp/x ./install.sh
set -eu

REPO="${REPO:-1273984347/dsh-github-gate}"
VERSION="${VERSION:-}"
PREFIX="${PREFIX:-${TMPDIR:-/tmp}/dsh-github-gate-install}"
USER_AGENT="dsh-github-gate-installer"

say() { printf '==> %s\n' "$1"; }
ok() { printf '  ok  %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v tar >/dev/null 2>&1 || die 'tar is required'

if [ -n "$VERSION" ]; then
  api="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
else
  api="https://api.github.com/repos/${REPO}/releases/latest"
fi

say "reading $api"
json="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: ${USER_AGENT}" "$api")" \
  || die "could not read the release for ${REPO}"

# No jq dependency: the two fields needed are extracted with sed. A release payload
# is one line of JSON per field only in pretty mode, so ask for compact output and
# pull the first asset's name / digest / download URL by position.
compact="$(printf '%s' "$json" | tr -d '\n' | sed 's/  */ /g')"
tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
name="$(printf '%s' "$compact" | sed -n 's/.*"name": *"\([^"]*\.tgz\)".*/\1/p' | head -n 1)"
digest="$(printf '%s' "$compact" | sed -n 's/.*"digest": *"sha256:\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)"
url="$(printf '%s' "$compact" | sed -n 's/.*"browser_download_url": *"\([^"]*\.tgz\)".*/\1/p' | head -n 1)"

[ -n "$tag" ] || die 'could not parse the release tag'
[ -n "$name" ] || die "release ${tag} carries no installable .tgz asset"
[ -n "$url" ] || die "release ${tag} has no download URL for ${name}"

ok "release ${tag}, asset ${name}"
if [ -z "$digest" ]; then
  printf 'warning: this release publishes no sha256 digest, so the download cannot be verified\n' >&2
fi

mkdir -p "$PREFIX"
target="${PREFIX}/${name}"

say "downloading to ${target}"
curl -fsSL -H "User-Agent: ${USER_AGENT}" -o "$target" "$url" || die 'download failed'
ok "downloaded $(wc -c < "$target" | tr -d ' ') bytes"

if [ -n "$digest" ]; then
  say 'verifying sha256'
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$target" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$target" | cut -d' ' -f1)"
  else
    die 'no sha256sum or shasum available to verify the download'
  fi
  if [ "$actual" != "$digest" ]; then
    rm -f "$target"
    die "digest mismatch (expected ${digest}, got ${actual}); the download was deleted"
  fi
  ok 'sha256 matches the digest GitHub publishes'
fi

cat <<EOF

Not installed — two things remain, and neither belongs to this script:
  1. install the path above with the Harness plugin manager:
       plugin_manager { action: "install_bundle", target: "${target}" }
  2. verify the running generation afterwards (a tool or Config key that only
     exists in the new version). The plugin manager re-activates the entry; the
     installed package.json is not proof, because pnpm replaces it first.

Tarball: ${target}
EOF
