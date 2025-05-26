FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package.json và package-lock.json của auth-service
# từ services/02-auth-service/ (trong build context là thư mục gốc)
# vào /usr/src/app/ (WORKDIR bên trong image)
COPY services/02-auth-service/package*.json ./

# Cài đặt chỉ dependencies cho production
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn của auth-service
# từ services/02-auth-service/ (trong build context là thư mục gốc)
# vào /usr/src/app/ (WORKDIR bên trong image).
# Điều này sẽ copy thư mục src/, file server.js, etc. của auth-service vào /usr/src/app/
COPY services/02-auth-service/. ./  

# Copy thư mục protos từ thư mục gốc của dự án (build context)
# vào /usr/src/app/protos bên trong image.
COPY protos /usr/src/app/protos

RUN ls -R /usr/src/app

EXPOSE 50052

# Giả sử file entry point là /usr/src/app/src/server.js
CMD [ "node", "src/server.js" ]