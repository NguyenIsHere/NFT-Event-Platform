# Sử dụng Node.js 20 Alpine làm image cơ sở
FROM node:20-alpine AS base

# Đặt biến môi trường cho production
ENV NODE_ENV=production

# Đặt thư mục làm việc bên trong image
WORKDIR /usr/src/app

# Sao chép package.json và package-lock.json (hoặc yarn.lock) của blockchain-service
COPY services/06-blockchain-service/package*.json ./

# Cài đặt chỉ dependencies cần thiết cho production
RUN npm ci --omit=dev

# Sao chép mã nguồn của blockchain-service (bao gồm thư mục src/ và file .env)
COPY services/06-blockchain-service/src ./src
COPY services/06-blockchain-service/.env ./.env

# Sao chép thư mục protos dùng chung từ gốc dự án
COPY protos ./protos 

# (Tùy chọn) Liệt kê cấu trúc thư mục bên trong image để debug
RUN ls -R .

# Expose port mà blockchain-service sẽ lắng nghe
EXPOSE ${PORT:-50056}

# Lệnh để chạy ứng dụng
CMD [ "node", "src/server.js" ]