# A disposable "fresh VPS" for integration/failure tests: real systemd, real sshd, real ufw,
# outbound internet for apt — the same surface A6-A11's SSH playbooks will run against on a real
# server. See testbed/README.md for how to run this and why it needs to be privileged.
ARG UBUNTU=24.04
FROM ubuntu:${UBUNTU}

ARG ROOT_PASSWORD=Testbed-Root-Pw-7a91!
ARG ROOT_USER=root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
      openssh-server sudo ufw iptables \
      ca-certificates curl gnupg tzdata locales cron rsyslog \
      debian-keyring debian-archive-keyring apt-transport-https \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Remove systemd units that break (or just add noise) inside a container — the standard recipe for
# systemd-in-docker images: no real tty to run a getty on, and udev has no real devices to manage.
RUN systemctl mask \
      systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-udev-trigger.service \
      getty.target getty-static.service \
      console-getty.service \
    && systemctl set-default multi-user.target

# root login, password auth: mimics a real cloud image's defaults (PasswordAuthentication yes,
# PermitRootLogin yes) so our A6 00- hardening drop-in has something real to override and a test can
# assert *our* drop-in wins over one that already permits everything.
RUN mkdir -p /etc/ssh/sshd_config.d && \
    printf 'PasswordAuthentication yes\nPermitRootLogin yes\n' > /etc/ssh/sshd_config.d/50-cloud-init.conf && \
    ssh-keygen -A && \
    systemctl enable ssh

RUN echo "${ROOT_USER}:${ROOT_PASSWORD}" | chpasswd

# A second, non-root sudo user — mimics cloud images that ship with root login disabled and only a
# provisioned sudo user (e.g. Debian's "admin", DigitalOcean-style images). Used by tests that pass
# rootUser=ubuntu. ubuntu:23.04+ base images already ship a uid-1000 `ubuntu` user, 22.04 does not,
# so create it only when missing and normalise shell/groups either way.
RUN (id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu) && \
    usermod -s /bin/bash -aG sudo ubuntu && \
    echo "ubuntu:${ROOT_PASSWORD}" | chpasswd && \
    echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ubuntu-nopasswd && \
    chmod 0440 /etc/sudoers.d/90-ubuntu-nopasswd

# ufw defaults: deny incoming, allow outgoing, matching a fresh VPS before our hardening playbook runs.
RUN ufw default deny incoming && ufw default allow outgoing

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
