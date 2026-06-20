FROM grafana/k6:1.0.0

USER root
RUN apk add --no-cache python3 py3-psycopg2 py3-pip \
  && python3 -m pip install --no-cache-dir --break-system-packages pymongo

WORKDIR /loadtest

COPY scenarios ./scenarios
COPY flows ./flows
COPY lib ./lib
COPY scripts ./scripts

USER 12345

ENTRYPOINT ["k6"]
CMD ["run", "/loadtest/scenarios/read-api-baseline.js"]
