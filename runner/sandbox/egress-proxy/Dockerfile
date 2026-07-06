# Gaffer egress-allowlist proxy. Tiny alpine + tinyproxy; default-deny with a host
# filter. The delivery container reaches the internet ONLY through this (it is on an
# --internal docker network with no NAT of its own). Built from alpine (not a random
# hub image) so the proxy itself is auditable.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter
EXPOSE 8888
# -d = don't daemonize (stay in foreground for docker), -c = config path.
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
