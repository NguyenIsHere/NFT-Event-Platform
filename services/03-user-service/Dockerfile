FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của user-service
COPY services/03-user-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của user-service
COPY services/03-user-service/. ./ 

# Copy thư mục protos
COPY protos /usr/src/app/protos

RUN ls -R /usr/src/app

EXPOSE 50053

CMD [ "node", "src/server.js" ]