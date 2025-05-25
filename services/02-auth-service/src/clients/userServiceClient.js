const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')

const USER_SERVICE_ADDRESS =
  process.env.USER_SERVICE_ADDRESS || 'localhost:50051'

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const USER_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'user.proto')

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER] // <<< THÊM DÒNG NÀY
})
const userProto = grpc.loadPackageDefinition(packageDefinition).user

const userServiceClient = new userProto.UserService(
  USER_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = userServiceClient
