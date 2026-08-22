#!/usr/bin/env bash
# Locate a libghostty-vt install and build the helpers that link against it.
#
# Ghostty ships libghostty-vt with its snap (and with a source build's
# zig-out). Sourcing this script sets GHOSTTY_PREFIX; running it builds
# scripts/ghostty-keys and scripts/ghostty-width into $BUILD_DIR (default
# scripts/.build). Exits 1 if no install is found, so callers can skip.
set -euo pipefail

find_prefix() {
	if [ -n "${GHOSTTY_PREFIX:-}" ] && [ -f "$GHOSTTY_PREFIX/include/ghostty/vt.h" ]; then
		echo "$GHOSTTY_PREFIX"
		return 0
	fi
	local candidate
	for candidate in /snap/ghostty/current /usr/local /usr "$HOME/.local"; do
		if [ -f "$candidate/include/ghostty/vt.h" ] && ls "$candidate"/lib/libghostty-vt.so* >/dev/null 2>&1; then
			echo "$candidate"
			return 0
		fi
	done
	# Newest numbered snap revision, if `current` is not linked.
	candidate=$(ls -d /snap/ghostty/[0-9]* 2>/dev/null | sort -V | tail -1 || true)
	if [ -n "$candidate" ] && [ -f "$candidate/include/ghostty/vt.h" ]; then
		echo "$candidate"
		return 0
	fi
	return 1
}

GHOSTTY_PREFIX=$(find_prefix) || {
	echo "libghostty-vt not found (looked in /snap/ghostty, /usr/local, /usr, ~/.local)." >&2
	echo "Install Ghostty, or set GHOSTTY_PREFIX to a tree with include/ghostty/vt.h." >&2
	exit 1
}
export GHOSTTY_PREFIX

# When sourced, stop here: the caller just wanted GHOSTTY_PREFIX.
(return 0 2>/dev/null) && return 0

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD_DIR=${BUILD_DIR:-$HERE/.build}
mkdir -p "$BUILD_DIR"

build() {
	local name=$1 lang=$2
	local src="$HERE/$name.$lang" out="$BUILD_DIR/$name"
	if [ -f "$out" ] && [ "$out" -nt "$src" ]; then return 0; fi
	local compiler=gcc
	[ "$lang" = "cc" ] && compiler=g++
	"$compiler" -O2 -I"$GHOSTTY_PREFIX/include" "$src" \
		-L"$GHOSTTY_PREFIX/lib" -lghostty-vt -Wl,-rpath,"$GHOSTTY_PREFIX/lib" -o "$out"
	echo "built $out"
}

build ghostty-keys c
build ghostty-width cc
echo "GHOSTTY_PREFIX=$GHOSTTY_PREFIX"
