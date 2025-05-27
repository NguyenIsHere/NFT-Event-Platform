// 04-event-service/src/clients/ipfsServiceClient.js (VÍ DỤ CƠ BẢN)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

const PROTOS_ROOT_DIR = path.resolve(__dirname, '..', '..', 'protos') // Trỏ ra thư mục protos chung trong image
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ipfs.proto')

const packageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})
const ipfsProto = grpc.loadPackageDefinition(packageDefinition).ipfs

const IPFS_SERVICE_ADDRESS =
  process.env.IPFS_SERVICE_ADDRESS || 'localhost:50058'

const ipfsServiceClient = new ipfsProto.IpfsService(
  IPFS_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = ipfsServiceClient
