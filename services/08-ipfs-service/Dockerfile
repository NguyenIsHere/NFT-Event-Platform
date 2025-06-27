FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của ipfs-service
COPY services/08-ipfs-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của ipfs-service
COPY services/08-ipfs-service/. ./ 

# Copy thư mục protos
COPY protos /usr/src/app/protos

EXPOSE 50058

CMD [ "node", "src/server.js" ]