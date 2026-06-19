FROM grafana/k6:1.0.0

WORKDIR /loadtest

COPY scenarios ./scenarios
COPY flows ./flows
COPY lib ./lib

ENTRYPOINT ["k6"]
CMD ["run", "/loadtest/scenarios/read-api-baseline.js"]
