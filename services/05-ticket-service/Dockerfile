FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của ticket-service
COPY services/05-ticket-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của ticket-service
COPY services/05-ticket-service/. ./ 

# Copy thư mục protos
COPY protos /usr/src/app/protos

EXPOSE 50055

CMD [ "node", "src/server.js" ]