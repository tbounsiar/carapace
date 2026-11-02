FROM alpine:3.20
RUN apk add --no-cache openssh-server \
    && adduser -D -s /bin/sh carapace \
    && mkdir -p /home/carapace/.ssh \
    && chown -R carapace:carapace /home/carapace/.ssh \
    && chmod 700 /home/carapace/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
