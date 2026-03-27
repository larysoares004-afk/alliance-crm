FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# ARG antes do COPY — invalida cache do npm install quando muda
ARG CACHEBUST=20260327i-polling-8s-fix
RUN echo "Cache bust: $CACHEBUST"
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
