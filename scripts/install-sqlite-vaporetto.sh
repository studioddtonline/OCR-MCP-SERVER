#!/usr/bin/env bash
set -euo pipefail

# Pin the release and verify the upstream SHA-256 before extracting a native library.
VERSION="v0.4.0"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/native/sqlite-vaporetto}"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" != "Linux" ]]; then
  echo "This installer targets Linux; detected operating system: $OS" >&2
  echo "See docs/japanese-search.md for other official release assets." >&2
  exit 2
fi

case "$ARCH" in
  x86_64|amd64)
    ASSET="sqlite-vaporetto-${VERSION}-linux-x86_64-with-model.tar.gz"
    SHA256="2a373575ea12d3617ce495c428f87ac714ada38c5f87627f9e1434c1b12677d1"
    ;;
  aarch64|arm64)
    ASSET="sqlite-vaporetto-${VERSION}-linux-aarch64-with-model.tar.gz"
    SHA256="bb79343bdb430bb120a4a9d3fe42a954685813be74fb39030ca7c1ca4e8975b0"
    ;;
  *)
    echo "Unsupported Linux architecture: $ARCH" >&2
    echo "This installer supports Linux x86_64 and aarch64. See docs/japanese-search.md for upstream build options." >&2
    exit 2
    ;;
esac

URL="https://github.com/hotchpotch/sqlite-vaporetto/releases/download/${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST"
echo "Downloading sqlite-vaporetto ${VERSION} for Linux ${ARCH}..."
curl --fail --location --retry 3 --output "$TMP/$ASSET" "$URL"
printf '%s  %s\n' "$SHA256" "$TMP/$ASSET" | sha256sum --check
mkdir "$TMP/extracted"
tar --extract --gzip --file "$TMP/$ASSET" --directory "$TMP/extracted" --no-same-owner --no-same-permissions
EXTENSION="$(find "$TMP/extracted" -type f -name 'libsqlite_vaporetto.so' -print -quit)"
if [[ -z "$EXTENSION" ]]; then
  echo "Verified archive did not contain libsqlite_vaporetto.so; inspect the upstream release assets." >&2
  exit 1
fi
install -m 755 "$EXTENSION" "$DEST/libsqlite_vaporetto.so"
find "$TMP/extracted" -type f \( -iname 'LICENSE*' -o -name 'MODEL_LICENSES.md' \) -exec cp -n {} "$DEST/" \;
cat > "$DEST/NOTICE.md" <<NOTICE
sqlite-vaporetto release: ${VERSION}

The native sqlite-vaporetto extension is licensed MIT OR Apache-2.0.
The -with-model package embeds bccwj-suw+unidic_pos+kana.model.zst, which is licensed BSD-3-Clause.
Release/source and complete upstream license notices: https://github.com/hotchpotch/sqlite-vaporetto
NOTICE
echo "Installed: $DEST/libsqlite_vaporetto.so"
echo "The -with-model release embeds the documented Vaporetto model; no separate model path is required."
echo "Run: node scripts/check-sqlite-vaporetto.mjs --extension=$DEST/libsqlite_vaporetto.so"
