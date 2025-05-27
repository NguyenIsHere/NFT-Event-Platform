// 04-event-service/src/clients/blockchainServiceClient.js (VÍ DỤ CƠ BẢN)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

const PROTOS_ROOT_DIR = path.resolve(__dirname, '..', '..', 'protos')
const BLOCKCHAIN_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'blockchain.proto')

const packageDefinition = protoLoader.loadSync(BLOCKCHAIN_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})
const blockchainProto = grpc.loadPackageDefinition(packageDefinition).blockchain

const BLOCKCHAIN_SERVICE_ADDRESS =
  process.env.BLOCKCHAIN_SERVICE_ADDRESS || 'localhost:50056'

const blockchainServiceClient = new blockchainProto.BlockchainService(
  BLOCKCHAIN_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = blockchainServiceClient
