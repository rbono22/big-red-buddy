ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 TMPDIR=/tmp
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json server.mjs worker.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node resources/job-source-catalog.json resources/jct-mba-resume-template.json resources/academic-calendar-2026-2027.json ./resources/
COPY --chown=node:node public ./public
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/migrate.mjs scripts/ocr-image.swift ./scripts/
COPY --chown=node:node deploy/container-entrypoint.sh deploy/database-url.mjs deploy/worker-health.mjs ./deploy/
USER node
EXPOSE 4318
ENTRYPOINT ["/bin/sh", "/app/deploy/container-entrypoint.sh"]
CMD ["npm", "start"]
