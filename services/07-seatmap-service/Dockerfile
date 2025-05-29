FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của seatmap-service
COPY services/07-seatmap-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của seatmap-service
COPY services/07-seatmap-service/. ./ 

# Copy thư mục protos
COPY protos /usr/src/app/protos

EXPOSE 50057

CMD [ "node", "src/server.js" ]