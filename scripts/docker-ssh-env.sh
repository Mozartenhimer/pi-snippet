#!/usr/bin/env bash
# Build the two-container SSH environment the remote-clicking harness drives.
#
# Terminal-resolved clicking over SSH is the one path that cannot be tested on
# one machine: the click resolves on the *client*, the socket lives on the
# *server*, and the whole feature is the wire between them. Faking SSH_TTY (as
# scripts/ssh-remote-tmux.py does) exercises the UI and nothing else. This
# builds the real thing — sshd, two hosts, a unix-socket forward.
#
# No image is pulled. Registry blob CDNs are commonly blocked by egress policy,
# and a harness that needs Docker Hub is a harness that stops working; the base
# is debootstrapped from the distro archive instead, then imported. Node and pi
# are copied in from this machine, so the container runs the same pi the rest of
# the harnesses do.
#
# Idempotent: re-running reuses the image and recreates the containers.
#
# Usage:  sudo bash scripts/docker-ssh-env.sh          # build + start
#         sudo bash scripts/docker-ssh-env.sh --clean  # tear down first
set -euo pipefail

IMAGE=pisnip-test:latest
NET=pisnip-net
SERVER=pisnip-server
CLIENT=pisnip-client
UID_DEV=1500
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${PISNIP_DOCKER_BUILD:-/tmp/pisnip-docker-build}"
SUITE="${PISNIP_SUITE:-noble}"
MIRROR="${PISNIP_MIRROR:-http://archive.ubuntu.com/ubuntu}"

[ "$(id -u)" = 0 ] || { echo "needs root (debootstrap and docker)" >&2; exit 1; }

if [ "${1:-}" = "--clean" ]; then
	docker rm -f "$SERVER" "$CLIENT" 2>/dev/null || true
	docker rmi -f "$IMAGE" 2>/dev/null || true
	rm -rf "$BUILD"
fi

command -v docker >/dev/null || { echo "docker not installed" >&2; exit 1; }
docker info >/dev/null 2>&1 || {
	echo "docker daemon not running; starting it" >&2
	dockerd >/tmp/pisnip-dockerd.log 2>&1 &
	for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
	docker info >/dev/null 2>&1 || { echo "could not start dockerd (see /tmp/pisnip-dockerd.log)" >&2; exit 1; }
}

NODE_BIN="$(command -v node)"
NODE_BIN="$(readlink -f "$NODE_BIN")"
PI_CLI="${PISNIP_PI_CLI:-}"
if [ -z "$PI_CLI" ]; then
	for c in /opt/pi-install/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
	         "$REPO/../pi-install/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"; do
		[ -f "$c" ] && { PI_CLI="$c"; break; }
	done
fi
[ -n "$PI_CLI" ] && [ -f "$PI_CLI" ] || {
	echo "no pi found. Install it outside the repo (CLAUDE.md):" >&2
	echo "  mkdir -p /opt/pi-install && cd /opt/pi-install && npm init -y && npm i @earendil-works/pi-coding-agent" >&2
	echo "or set PISNIP_PI_CLI to a cli.js" >&2
	exit 1
}
PI_ROOT="$(cd "$(dirname "$PI_CLI")/../../../.." && pwd)"   # .../node_modules

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "building $IMAGE (no registry pull; debootstrap + import)"
	R="$BUILD/rootfs"
	if [ ! -d "$R" ]; then
		command -v debootstrap >/dev/null || { echo "install debootstrap first" >&2; exit 1; }
		mkdir -p "$BUILD"
		debootstrap --variant=minbase \
			--include=openssh-server,openssh-client,python3,tmux,ca-certificates,procps,iproute2,netcat-openbsd,sudo,less \
			"$SUITE" "$R" "$MIRROR"
	fi

	# node + pi, copied from this machine so the container runs the same pi.
	mkdir -p "$R/opt/node22/bin" "$R/opt/pi-install"
	cp -f "$NODE_BIN" "$R/opt/node22/bin/node"
	ln -sf /opt/node22/bin/node "$R/usr/local/bin/node"
	rm -rf "$R/opt/pi-install/node_modules"
	cp -a "$PI_ROOT" "$R/opt/pi-install/node_modules"
	printf '#!/bin/sh\nexec /opt/node22/bin/node /opt/pi-install/node_modules/@earendil-works/pi-coding-agent/dist/cli.js "$@"\n' \
		> "$R/usr/local/bin/pi"
	chmod +x "$R/usr/local/bin/pi"

	# sshd: keys only, and unix-socket forwarding, which is the feature's wire.
	mkdir -p "$R/run/sshd"
	sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$R/etc/ssh/sshd_config"
	sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$R/etc/ssh/sshd_config"
	grep -q StreamLocalBindUnlink "$R/etc/ssh/sshd_config" || echo "StreamLocalBindUnlink yes" >> "$R/etc/ssh/sshd_config"
	echo "nameserver 8.8.8.8" > "$R/etc/resolv.conf"

	# One user, same uid on both ends, so /tmp/pi-snippet-<uid> reads the same
	# on each side of the forward — as it would for one person's two machines.
	chroot "$R" /bin/bash -c "id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -u $UID_DEV dev"
	chroot "$R" /bin/bash -c "mkdir -p /home/dev/.ssh && chmod 700 /home/dev/.ssh"
	chroot "$R" /bin/bash -c "ssh-keygen -A" >/dev/null 2>&1
	[ -f "$R/home/dev/.ssh/id_ed25519" ] || \
		chroot "$R" /bin/bash -c "ssh-keygen -t ed25519 -N '' -f /home/dev/.ssh/id_ed25519 -q"
	cp -f "$R/home/dev/.ssh/id_ed25519.pub" "$R/home/dev/.ssh/authorized_keys"
	# A real ssh-config alias: the ssh-back relay resolves its host through the
	# user's own ~/.ssh/config, so the harness uses that mechanism too.
	cat > "$R/home/dev/.ssh/config" <<SSHCFG
Host piserver
    HostName $SERVER
    User dev
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts
SSHCFG
	chroot "$R" /bin/bash -c "chown -R dev:dev /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys /home/dev/.ssh/id_ed25519 /home/dev/.ssh/config"

	(cd "$R" && tar -c .) | docker import -c 'CMD ["/bin/bash"]' - "$IMAGE" >/dev/null
	echo "built $IMAGE"
fi

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$SERVER" "$CLIENT" >/dev/null 2>&1 || true
docker run -d --name "$SERVER" --hostname "$SERVER" --network "$NET" \
	-v "$REPO:/repo:ro" "$IMAGE" \
	/bin/bash -c "mkdir -p /run/sshd && /usr/sbin/sshd -D -e" >/dev/null
docker run -d --name "$CLIENT" --hostname "$CLIENT" --network "$NET" \
	-v "$REPO:/repo:ro" "$IMAGE" sleep infinity >/dev/null

for _ in $(seq 1 30); do
	docker exec -u dev "$CLIENT" ssh -o BatchMode=yes -o ConnectTimeout=2 piserver true 2>/dev/null && break
	sleep 1
done
docker exec -u dev "$CLIENT" ssh -o BatchMode=yes piserver true \
	|| { echo "client cannot ssh to server" >&2; exit 1; }
echo "$SERVER and $CLIENT are up; ssh works"
