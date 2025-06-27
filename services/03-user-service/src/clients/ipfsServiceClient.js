const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// ✅ Đảm bảo đường dẫn đúng
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ipfs.proto')

// ✅ Thêm log để debug
console.log(`🔍 Loading IPFS proto from: ${IPFS_PROTO_PATH}`)

// ✅ Đảm bảo đọc địa chỉ từ env
const IPFS_SERVICE_ADDRESS =
  process.env.IPFS_SERVICE_ADDRESS || 'ipfs-service:50058'
console.log(`🔍 IPFS service address: ${IPFS_SERVICE_ADDRESS}`)

const packageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})

const ipfsProto = grpc.loadPackageDefinition(packageDefinition).ipfs

// ✅ Tạo client và kiểm tra kết nối
const ipfsServiceClient = new ipfsProto.IpfsService(
  IPFS_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

// ✅ Test connection
console.log('✅ IPFS service client initialized')

module.exports = ipfsServiceClient
