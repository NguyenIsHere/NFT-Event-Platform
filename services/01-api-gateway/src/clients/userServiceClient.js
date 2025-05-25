const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const USER_SERVICE_ADDRESS = process.env.USER_SERVICE_ADDRESS
const USER_PROTO_PATH = path.resolve(process.cwd(), 'protos', 'user.proto')

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const userProto = grpc.loadPackageDefinition(packageDefinition).user // 'user' là package name

if (!USER_SERVICE_ADDRESS) {
  console.error(
    'FATAL ERROR: USER_SERVICE_ADDRESS is not defined in .env for api-gateway'
  )
  process.exit(1)
}

const userServiceClient = new userProto.UserService(
  USER_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

console.log(`UserService client configured for: ${USER_SERVICE_ADDRESS}`)
module.exports = userServiceClient
