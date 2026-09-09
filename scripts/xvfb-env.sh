#!/usr/bin/env bash
# A display for scripts/alacritty-click.py, on a machine that has no desktop.
#
# Alacritty needs an X server and a font; xdotool moves the pointer and xclip
# reads the selection back. Xvfb is enough for all three — alacritty renders
# through mesa's software GL there, and a click delivered by XTEST is a click.
# Nothing here is specific to Alacritty except the package name.
#
#   bash scripts/xvfb-env.sh          # start :99 (idempotent)
#   DISPLAY=:99 python3 scripts/alacritty-click.py
set -euo pipefail

DISPLAY_NUM="${1:-:99}"

missing=()
for tool in Xvfb alacritty xdotool xclip; do
	command -v "$tool" >/dev/null || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
	echo "missing: ${missing[*]}" >&2
	echo "on Debian/Ubuntu: apt-get install -y xvfb alacritty xdotool xclip libxkbcommon-x11-0" >&2
	# libxkbcommon-x11 is not pulled in by the alacritty package and alacritty
	# panics at startup without it, which reads like a broken display.
	exit 1
fi

if DISPLAY="$DISPLAY_NUM" xdotool getdisplaygeometry >/dev/null 2>&1; then
	echo "$DISPLAY_NUM is already up"
else
	Xvfb "$DISPLAY_NUM" -screen 0 1280x800x24 >/tmp/xvfb-"${DISPLAY_NUM#:}".log 2>&1 &
	sleep 2
	DISPLAY="$DISPLAY_NUM" xdotool getdisplaygeometry >/dev/null
	echo "started Xvfb on $DISPLAY_NUM"
fi

echo "now: DISPLAY=$DISPLAY_NUM python3 scripts/alacritty-click.py"
