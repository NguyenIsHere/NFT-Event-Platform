// 04-event-service/src/clients/blockchainServiceClient.js
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

const PROTOS_ROOT_DIR = path.resolve(__dirname, '..', 'protos')
const BLOCKCHAIN_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'blockchain.proto')

const blockchainPackageDefinition = protoLoader.loadSync(
  BLOCKCHAIN_PROTO_PATH,
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTOS_ROOT_DIR]
  }
)
const blockchainProto = grpc.loadPackageDefinition(
  blockchainPackageDefinition
).blockchain // package 'blockchain'

const BLOCKCHAIN_SERVICE_ADDRESS =
  process.env.BLOCKCHAIN_SERVICE_ADDRESS || 'localhost:50056' // Lấy từ .env

console.log(
  `EventService: Blockchain client connecting to ${BLOCKCHAIN_SERVICE_ADDRESS}`
)
const blockchainServiceClient = new blockchainProto.BlockchainService(
  BLOCKCHAIN_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = blockchainServiceClient
