FROM node:25-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js deploy-commands.js ./

VOLUME ["/data"]

ENV DB_PATH=/data/maptap.db

CMD ["node", "--experimental-sqlite", "index.js"]
