FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# uncomment if the project gained third-party deps:
# RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
