# Sử dụng Node.js 20 Alpine làm image cơ sở
FROM node:20-alpine AS base

# Đặt biến môi trường cho production
ENV NODE_ENV=production

# Đặt thư mục làm việc bên trong image
WORKDIR /usr/src/app

# Sao chép package.json và package-lock.json (hoặc yarn.lock) của ipfs-service
# từ services/08-ipfs-service/ (trong build context là thư mục gốc của dự án)
# vào /usr/src/app/ (WORKDIR bên trong image)
COPY services/08-ipfs-service/package*.json ./

# Cài đặt chỉ dependencies cần thiết cho production
# npm ci sẽ cài đặt chính xác các phiên bản trong package-lock.json
RUN npm ci --omit=dev

# Sao chép toàn bộ mã nguồn của ipfs-service (bao gồm thư mục src/ và file .env)
# từ services/08-ipfs-service/ (trong build context là thư mục gốc)
# vào /usr/src/app/ (WORKDIR bên trong image).
COPY services/08-ipfs-service/. ./

# Sao chép thư mục protos dùng chung từ thư mục gốc của dự án (build context)
# vào /usr/src/app/protos bên trong image.
# Điều này đảm bảo server.js trong src/ có thể truy cập ../protos/ipfs.proto
COPY protos /usr/src/app/protos

# (Tùy chọn) Liệt kê cấu trúc thư mục bên trong image để debug
RUN ls -R /usr/src/app

# Expose port mà ipfs-service sẽ lắng nghe (50058 theo quy ước của bạn)
# Biến PORT này cũng nên được định nghĩa trong file .env của ipfs-service
EXPOSE ${PORT:-50058}

# Lệnh để chạy ứng dụng
# Giả sử file entry point của bạn là /usr/src/app/src/server.js
CMD [ "node", "src/server.js" ]
