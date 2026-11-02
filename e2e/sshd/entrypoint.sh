#!/bin/sh
set -e
ssh-keygen -A
cp /provision/authorized_keys /home/carapace/.ssh/authorized_keys
chown carapace:carapace /home/carapace/.ssh/authorized_keys
chmod 600 /home/carapace/.ssh/authorized_keys
echo "carapace:${CARAPACE_PASSWORD}" | chpasswd
exec /usr/sbin/sshd -D -e
