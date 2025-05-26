FROM node:20-alpine

# Thiết lập thư mục làm việc bên trong container
WORKDIR /usr/src/app

# Sao chép package.json và package-lock.json (hoặc yarn.lock) vào thư mục làm việc
COPY services/08-ipfs-service/package*.json ./

# Cài đặt các dependencies cho production
RUN npm ci --omit=dev

# Sao chép thư mục src của service này vào thư mục src trong container
COPY services/08-ipfs-service/src ./src

# Sao chép file .env của service này vào thư mục làm việc trong container
COPY services/08-ipfs-service/.env ./.env

# Sao chép thư mục protos dùng chung từ gốc dự án vào thư mục protos bên trong thư mục làm việc của service
# Điều này giúp server.js trong src/ có thể load proto từ ./protos/ipfs.proto (tương đối với /usr/src/app)
COPY protos ./protos 

# (Tùy chọn) Liệt kê file để debug đường dẫn trong quá trình build
RUN ls -R .

# Expose port mà service sẽ chạy (lấy từ biến môi trường hoặc mặc định)
EXPOSE 50058

# Lệnh để chạy service
CMD [ "node", "src/server.js" ]