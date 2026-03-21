FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --production && echo "build:2026-03-21"
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
