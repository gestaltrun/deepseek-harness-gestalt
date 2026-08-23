# Platform image. Built and published by .github/workflows/platform-image.yml.
# Secrets are injected at container start, never baked into layers.
FROM node:24-bookworm-slim

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin platform
WORKDIR /app
RUN npm install ali-oss@6.23.0 pg@8.23.0 redis@6.2.1 --omit=dev
COPY --chown=platform:platform dist ./dist
COPY --chown=platform:platform public ./public
USER platform
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/boot.mjs"]
