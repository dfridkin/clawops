# A container that behaves enough like a VM for the local provider's bootstrap to run in it.
#
# The previous SSH target was linuxserver/openssh-server, which has no apt-get and no init, so
# the bootstrap could not run and the e2e test mocked it out. The Linux path in
# src/providers/local/bootstrap.sh.tmpl installs Docker from the apt repo, writes
# /etc/systemd/system/openclaw.service and runs `systemctl enable --now` — none of which a
# plain container can do. This image has systemd as PID 1 and sshd under it, and deliberately
# does NOT preinstall Docker: installing it is part of what the test exercises.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -q && apt-get install -y -q --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      openssh-server sudo ca-certificates curl gnupg lsb-release iproute2 \
 && rm -rf /var/lib/apt/lists/*

# sshd needs its runtime dir and host keys; systemd starts the unit.
RUN mkdir -p /run/sshd && ssh-keygen -A && systemctl enable ssh

# The account clawops connects as. Passwordless sudo because the bootstrap is piped to
# `sudo bash` over a non-TTY exec channel.
ARG TEST_USER=clawops-test
RUN useradd -m -s /bin/bash ${TEST_USER} \
 && printf '%s ALL=(ALL) NOPASSWD:ALL\n' ${TEST_USER} > /etc/sudoers.d/${TEST_USER} \
 && chmod 0440 /etc/sudoers.d/${TEST_USER} \
 && mkdir -p /home/${TEST_USER}/.ssh && chmod 700 /home/${TEST_USER}/.ssh
# Passed in rather than copied: the public half of tests/integration/fixtures/test_key, which
# is committed and grants access to nothing but this throwaway container.
ARG AUTHORIZED_KEY
RUN printf '%s\n' "${AUTHORIZED_KEY}" > /home/${TEST_USER}/.ssh/authorized_keys \
 && chmod 600 /home/${TEST_USER}/.ssh/authorized_keys \
 && chown -R ${TEST_USER}:${TEST_USER} /home/${TEST_USER}/.ssh

# Units that cannot work in a container and only add noise to `systemctl` output.
RUN systemctl mask systemd-udevd systemd-udev-trigger systemd-modules-load \
      systemd-journald-audit.socket getty.target console-getty.service

STOPSIGNAL SIGRTMIN+3
EXPOSE 22
CMD ["/sbin/init"]
