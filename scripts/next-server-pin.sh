#!/usr/bin/env bash
# Move the extension's server pin to a just-published compiler release tag,
# when it should move (#1673). Called by pin-bump.yml.
#
# The pin names the last shipped *release*, so:
#   - a pre-release tag (`v1.2.3-rc1`) never becomes the pin;
#   - the pin never moves backwards (a re-run, or a late tag of an older
#     version, is a no-op).
# Any other tag shape is refused outright.
#
# Usage: scripts/next-server-pin.sh TAG [PACKAGE_JSON]
# Edits PACKAGE_JSON (default package.json) in place when the pin moves, and
# prints `move=true` or `move=false` on stdout (a GITHUB_OUTPUT line).
#
# The extension's own `version` follows the compiler's: a moved pin sets it to
# the release's version, or, when the extension is already at or past that (it
# shipped fixes of its own on that line), to its next patch. Tagging it is
# still a separate, deliberate step (release.yml).
set -euo pipefail

tag="${1:?usage: scripts/next-server-pin.sh TAG [PACKAGE_JSON]}"
pkg="${2:-$(dirname "$0")/../package.json}"

if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
	echo "::error::$tag is not a vX.Y.Z[-pre] release tag" >&2
	exit 1
fi
pin="$(sed -nE 's/^  "bynkServerVersion": "([^"]+)".*/\1/p' "$pkg")"
if [ -z "$pin" ]; then
	echo "::error::no bynkServerVersion line in $pkg" >&2
	exit 1
fi

if [ "${tag#*-}" != "$tag" ]; then
	echo "::notice::$tag is a pre-release; the pin stays at $pin" >&2
	echo "move=false"
elif [ "$(printf '%s\n%s\n' "$pin" "$tag" | sort -V | tail -n1)" = "$pin" ]; then
	echo "::notice::the pin is already $pin (not behind $tag)" >&2
	echo "move=false"
else
	sed -i.bak -E 's/^(  "bynkServerVersion": )"[^"]+"/\1"'"$tag"'"/' "$pkg"
	ext="$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$pkg")"
	if [ -z "$ext" ]; then
		echo "::error::no version line in $pkg" >&2
		exit 1
	fi
	next="${tag#v}"
	if [ "$(printf '%s\n%s\n' "$ext" "$next" | sort -V | tail -n1)" = "$ext" ]; then
		next="${ext%.*}.$(( ${ext##*.} + 1 ))"
	fi
	sed -i.bak -E 's/^(  "version": )"[^"]+"/\1"'"$next"'"/' "$pkg"
	rm -f "$pkg.bak"
	# The lockfile repeats the root package's version (lines 3 and 9 of an npm
	# lockfile); leave it alone if it is not there.
	lock="$(dirname "$pkg")/package-lock.json"
	if [ -f "$lock" ]; then
		sed -i.bak -E '1,12s/^(\s*"version": )"'"${ext//./\\.}"'"/\1"'"$next"'"/' "$lock"
		rm -f "$lock.bak"
	fi
	echo "::notice::moving the pin $pin -> $tag, extension version $ext -> $next" >&2
	echo "move=true"
fi
