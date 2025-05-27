// 04-event-service/src/clients/ipfsServiceClient.js
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ipfs.proto')

const ipfsPackageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})
const ipfsProto = grpc.loadPackageDefinition(ipfsPackageDefinition).ipfs // package 'ipfs'

const IPFS_SERVICE_ADDRESS =
  process.env.IPFS_SERVICE_ADDRESS || 'localhost:50058' // Lấy từ .env

console.log(`EventService: IPFS client connecting to ${IPFS_SERVICE_ADDRESS}`)
const ipfsServiceClient = new ipfsProto.IpfsService(
  IPFS_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = ipfsServiceClient
