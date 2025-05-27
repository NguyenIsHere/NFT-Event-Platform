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

# Copy toàn bộ mã nguồn của blockchain-service
COPY services/06-blockchain-service/. ./ 

# Copy thư mục protos
COPY protos /usr/src/app/protos

# SAO CHÉP ARTIFACT (CHỨA ABI) VÀO IMAGE
# Đường dẫn này phải khớp với nơi Hardhat build ra và contractUtils.js đọc vào
COPY services/06-blockchain-service/artifacts/contracts/EventTicketNFT.sol/EventTicketNFT.json ./artifacts/contracts/EventTicketNFT.sol/EventTicketNFT.json

# Expose port mà blockchain-service sẽ lắng nghe
EXPOSE ${PORT:-50056}

# Lệnh để chạy ứng dụng
CMD [ "node", "src/server.js" ]


