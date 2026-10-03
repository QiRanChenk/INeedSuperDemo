# SuperDemo shell. Projects run as child processes inside this container and are reached via the shell's /p/<id>/ proxy.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shell ./shell
COPY sdk ./sdk
COPY templates ./templates
VOLUME ["/app/data", "/app/projects"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "shell/server.js"]
