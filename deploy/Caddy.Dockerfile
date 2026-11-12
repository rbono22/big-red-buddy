ARG CADDY_IMAGE=caddy:2-alpine
FROM ${CADDY_IMAGE}
RUN mkdir -p /data/caddy /config/caddy && chown -R 1000:1000 /data /config
USER 1000:1000
