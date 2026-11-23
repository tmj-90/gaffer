# Gaffer egress-allowlist proxy. Tiny alpine + tinyproxy; default-deny with a host
# filter. The delivery container reaches the internet ONLY through this (it is on an
# --internal docker network with no NAT of its own). Built from alpine (not a random
# hub image) so the proxy itself is auditable.
# BASE IMAGE PINNED BY DIGEST (the multi-arch index of the tag), so a tag moved or
# replaced upstream cannot change what is built. Dependabot (docker, .github/dependabot.yml)
# proposes a new digest; to bump by hand, read the index digest of the tag and replace
# it here, e.g. `docker buildx imagetools inspect alpine:3.20` (the Digest line).
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter
EXPOSE 8888
# -d = don't daemonize (stay in foreground for docker), -c = config path.
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
