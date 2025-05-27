FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./

# Cài đặt chỉ dependencies cho production
# Ưu tiên dùng npm ci nếu có package-lock.json
RUN npm ci --omit=dev

COPY . .

COPY ../../protos /usr/src/app/protos

EXPOSE 50057
CMD [ "node", "src/server.js" ]