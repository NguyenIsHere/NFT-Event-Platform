const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') }) // Đảm bảo .env được load đúng cách

const AUTH_SERVICE_ADDRESS = process.env.AUTH_SERVICE_ADDRESS

// Đường dẫn tới file auth.proto (bên trong container, sau khi Docker copy)
const AUTH_PROTO_PATH = path.resolve(process.cwd(), 'protos', 'auth.proto')

const packageDefinition = protoLoader.loadSync(AUTH_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})

const authProto = grpc.loadPackageDefinition(packageDefinition).auth // 'auth' là package name

if (!AUTH_SERVICE_ADDRESS) {
  console.error(
    'FATAL ERROR: AUTH_SERVICE_ADDRESS is not defined in .env for api-gateway'
  )
  process.exit(1)
}

const authServiceClient = new authProto.AuthService(
  AUTH_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

console.log(`AuthService client configured for: ${AUTH_SERVICE_ADDRESS}`)
module.exports = authServiceClient
