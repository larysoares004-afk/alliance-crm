FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --production
# ARG muda a cada deploy — invalida o cache do COPY abaixo
ARG CACHEBUST=20260321
RUN echo "Deploy $CACHEBUST"
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
