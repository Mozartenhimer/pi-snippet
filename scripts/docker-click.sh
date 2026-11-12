#!/usr/bin/env bash
# pi in a Docker container, the click handler on the host: does a click land?
#
# The container shares the host's kernel, so a unix socket bound inside a
# bind-mounted directory is one the host can connect to — the only question is
# whether it is allowed to. This runs the real LinkServer inside a container
# (as root, Docker's default, and as the host user via --user) and the real
# generated handler on the host as an ordinary user, with the host user's
# $XDG_RUNTIME_DIR/pi-snippet bind-mounted in. Before the socket was handed to
# the directory's owner, the root case failed: the socket was root:root 0600.
#
# No image is pulled: an empty imported image, with the host's /usr and node
# bind-mounted read-only, is enough to run node.
#
# Usage:  sudo bash scripts/docker-click.sh
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "needs root (docker, and a second uid to play the host user)" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_UID="${PISNIP_HOST_UID:-1500}"
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
W="$(mktemp -d /tmp/pisnip-docker-click.XXXXXX)"
trap 'docker rm -f pisnip-click >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
chmod 755 "$W"

docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 1; }
docker image inspect pisnip-hostfs >/dev/null 2>&1 || {
	mkdir "$W/empty" && tar -C "$W/empty" -cf "$W/empty.tar" . && docker import "$W/empty.tar" pisnip-hostfs >/dev/null
}

cat >"$W/server.ts" <<EOF
import { LinkServer } from "$REPO/src/extension/link-server.ts";
const s = new LinkServer({ token: () => "abcd1234", resolve: (m, i) => \`msg \${m} chip \${i}\`,
	onActivate: (t) => { console.log("ACTIVATED:", t); process.exit(0); } });
console.log("bound", s.start());
setTimeout(() => process.exit(1), 15000);
EOF
cat >"$W/install.ts" <<EOF
import { install } from "$REPO/src/extension/link-install.ts";
install();
EOF
for f in server install; do
	"$REPO/node_modules/.bin/esbuild" "$W/$f.ts" --bundle --platform=node --outfile="$W/$f.cjs" --log-level=warning
done
chmod 644 "$W"/*.cjs

RUN="$W/run" HOME_U="$W/home"
mkdir -p "$RUN/pi-snippet" "$HOME_U"
chown -R "$HOST_UID:$HOST_UID" "$RUN" "$HOME_U"
chmod 700 "$RUN" "$RUN/pi-snippet"
as_host() { setpriv --reuid "$HOST_UID" --regid "$HOST_UID" --clear-groups env HOME="$HOME_U" XDG_RUNTIME_DIR="$RUN" XDG_DATA_HOME="$HOME_U/share" XDG_CONFIG_HOME="$HOME_U/config" "$@"; }
as_host node "$W/install.cjs"

fail=0
trial() { # $1 = label, rest = extra docker args
	local label="$1"; shift
	docker rm -f pisnip-click >/dev/null 2>&1 || true
	docker run -d --name pisnip-click --network none "$@" \
		-v /usr:/usr:ro -v /bin:/bin:ro -v /lib:/lib:ro -v /lib64:/lib64:ro -v /etc:/etc:ro \
		-v "$NODE_DIR:$NODE_DIR:ro" -v "$W:$W:ro" \
		-v "$RUN/pi-snippet:/run/pi-snippet" -e PI_SNIPPET_SOCKET_DIR=/run/pi-snippet \
		pisnip-hostfs "$NODE_DIR/bin/node" "$W/server.cjs" >/dev/null
	for _ in $(seq 1 50); do [ -S "$RUN/pi-snippet/abcd1234.sock" ] && break; sleep 0.1; done
	local ch; ch="$(docker inspect -f '{{.Config.Hostname}}' pisnip-click)"
	as_host python3 "$HOME_U/share/pi-snippet/open-handler" "pisnip://$ch/abcd1234/1f/c2" || true
	docker wait pisnip-click >/dev/null
	if docker logs pisnip-click | grep -q "ACTIVATED: msg 1f chip 2"; then
		echo "ok   $label"
	else
		echo "FAIL $label"; ls -la "$RUN/pi-snippet"; fail=1
	fi
}
trial "root in the container"
trial "--user $HOST_UID:$HOST_UID" --user "$HOST_UID:$HOST_UID"
exit "$fail"
