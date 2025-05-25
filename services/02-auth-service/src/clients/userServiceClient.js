const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')

const USER_SERVICE_ADDRESS =
  process.env.USER_SERVICE_ADDRESS || 'localhost:50051'

// Đường dẫn tới file user.proto (sẽ được copy vào /usr/src/app/protos/user.proto bởi Docker)
const USER_PROTO_PATH = path.resolve(process.cwd(), 'protos', 'user.proto')

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const userProto = grpc.loadPackageDefinition(packageDefinition).user

const userServiceClient = new userProto.UserService(
  USER_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = userServiceClient
