FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của auth-service
COPY services/02-auth-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của auth-service
COPY services/02-auth-service/. ./  

# Copy thư mục protos từ thư mục gốc của dự án (build context)
COPY protos /usr/src/app/protos

EXPOSE 50052

# Giả sử file entry point là /usr/src/app/src/server.js
CMD [ "node", "src/server.js" ]