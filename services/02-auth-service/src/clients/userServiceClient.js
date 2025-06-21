// userServiceClient.js - Add proper connection logging and health check
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')

const USER_SERVICE_ADDRESS =
  process.env.USER_SERVICE_ADDRESS || 'localhost:50053'

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const USER_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'user.proto')

console.log(`AuthService: Loading user proto from ${USER_PROTO_PATH}`)

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})
const userProto = grpc.loadPackageDefinition(packageDefinition).user

console.log(`AuthService: User client connecting to ${USER_SERVICE_ADDRESS}`)

const userServiceClient = new userProto.UserService(
  USER_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

// ✅ ADD: Test connection on startup
const testConnection = () => {
  console.log(
    `AuthService: Testing connection to User service at ${USER_SERVICE_ADDRESS}`
  )

  // Test with a simple call
  userServiceClient.waitForReady(Date.now() + 5000, error => {
    if (error) {
      console.error(
        `❌ AuthService: Failed to connect to User service:`,
        error.message
      )
    } else {
      console.log(
        `✅ AuthService: Successfully connected to User service at ${USER_SERVICE_ADDRESS}`
      )
    }
  })
}

// Test connection immediately
testConnection()

// ✅ ADD: Periodic connection check (similar to IPFS pattern)
setInterval(() => {
  userServiceClient.waitForReady(Date.now() + 3000, error => {
    if (error) {
      console.warn(
        `⚠️ AuthService: User service connection check failed:`,
        error.message
      )
    } else {
      console.log(`🔄 AuthService: User service connection healthy`)
    }
  })
}, 30000) // Check every 30 seconds

module.exports = userServiceClient
