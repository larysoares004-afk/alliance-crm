FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Baixa sempre o código mais recente do GitHub (nunca usa cache de arquivos)
ARG GIT_HASH=latest
RUN git clone --depth 1 https://github.com/larysoares004-afk/alliance-crm.git /tmp/repo \
    && cp -r /tmp/repo/. /app/ \
    && rm -rf /tmp/repo /app/.git
RUN npm install --production
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
