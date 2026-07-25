FROM node:22.17.1-bookworm-slim

WORKDIR /loadtest

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && mkdir -p /loadtest/reports /loadtest/cache \
    && chown -R 12345:12345 /loadtest

COPY --chown=12345:12345 datasets ./datasets
COPY --chown=12345:12345 lib/deterministic-data.js ./lib/deterministic-data.js

USER 12345:12345

ENTRYPOINT ["node", "/loadtest/datasets/seed.js"]
