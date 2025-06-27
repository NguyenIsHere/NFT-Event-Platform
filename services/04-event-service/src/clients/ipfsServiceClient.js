// src/clients/ipfsServiceClient.js (trong 04-event-service)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ipfs.proto')

if (!process.env.IPFS_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for EventService's IPFSClient: IPFS_SERVICE_ADDRESS is not defined in .env. Calls to IPFS service will likely use default 'localhost' and may fail in Docker."
  )
}
const IPFS_SERVICE_ADDRESS =
  process.env.IPFS_SERVICE_ADDRESS || 'localhost:50058' // Port của IPFS-service

console.log(
  `EventService: IPFS client attempting to connect to ${IPFS_SERVICE_ADDRESS} using proto: ${IPFS_PROTO_PATH}`
)

const ipfsPackageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR] // Cho phép import google/api/annotations.proto
})

const ipfsProto = grpc.loadPackageDefinition(ipfsPackageDefinition).ipfs // package 'IPFS'

const ipfsServiceClient = new ipfsProto.IpfsService(
  IPFS_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = ipfsServiceClient
