// src/clients/blockchainServiceClient.js (trong 05-Ticket-service)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đảm bảo .env được load để lấy BLOCKCHAIN_SERVICE_ADDRESS
// Giả sử server.js của Ticket-service đã load .env rồi, hoặc bạn có thể load ở đây nếu cần:
// require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const BLOCKCHAIN_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'blockchain.proto')

if (!process.env.BLOCKCHAIN_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for TicketService's BlockchainClient: BLOCKCHAIN_SERVICE_ADDRESS is not defined in .env. Calls to Blockchain service will likely use default 'localhost' and may fail in Docker."
  )
}
const BLOCKCHAIN_SERVICE_ADDRESS =
  process.env.BLOCKCHAIN_SERVICE_ADDRESS || 'localhost:50056' // Port của blockchain-service

console.log(
  `TicketService: Blockchain client attempting to connect to ${BLOCKCHAIN_SERVICE_ADDRESS} using proto: ${BLOCKCHAIN_PROTO_PATH}`
)

const blockchainPackageDefinition = protoLoader.loadSync(
  BLOCKCHAIN_PROTO_PATH,
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTOS_ROOT_DIR] // Cho phép import google/api/annotations.proto
  }
)

const blockchainProto = grpc.loadPackageDefinition(
  blockchainPackageDefinition
).blockchain // package 'blockchain'

const blockchainServiceClient = new blockchainProto.BlockchainService(
  BLOCKCHAIN_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = blockchainServiceClient
