FROM node:22.16.0-alpine3.22

RUN apk add --no-cache kcat \
  && addgroup -g 12345 loadtest \
  && adduser -D -H -u 12345 -G loadtest loadtest \
  && install -d -o 12345 -g 12345 /loadtest /tmp/loadtest

WORKDIR /loadtest
COPY --chown=12345:12345 scripts ./scripts
COPY --chown=12345:12345 lib/k6-metrics.js ./lib/k6-metrics.js
COPY --chown=12345:12345 lib/deterministic-data.js ./lib/deterministic-data.js
COPY --chown=12345:12345 scenarios/service-static-replica-capacity-load-test/report.js ./scenarios/service-static-replica-capacity-load-test/report.js
COPY --chown=12345:12345 scenarios/service-bottleneck-ramp-load-test/report.js ./scenarios/service-bottleneck-ramp-load-test/report.js
COPY --chown=12345:12345 package.json ./package.json

USER 12345:12345
ENTRYPOINT ["node"]
CMD ["--version"]
