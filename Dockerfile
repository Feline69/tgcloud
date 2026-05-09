FROM node:20-alpine

RUN apk add --no-cache ffmpeg python3 make g++ poppler-utils

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js setup.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
