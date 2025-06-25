const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const USER_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'user.proto')

// Kiểm tra biến môi trường
if (!process.env.USER_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for ChatbotService's UserClient: USER_SERVICE_ADDRESS is not defined in .env. Calls to User service will likely use default 'localhost' and may fail in Docker."
  )
}
const USER_SERVICE_ADDRESS =
  process.env.USER_SERVICE_ADDRESS || 'localhost:50053'

console.log(
  `ChatbotService: User client attempting to connect to ${USER_SERVICE_ADDRESS} using proto: ${USER_PROTO_PATH}`
)

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})

const userProto = grpc.loadPackageDefinition(packageDefinition).user

class UserClient {
  constructor () {
    this.client = new userProto.UserService(
      USER_SERVICE_ADDRESS,
      grpc.credentials.createInsecure()
    )
  }

  async getUserById (userId) {
    return new Promise((resolve, reject) => {
      this.client.GetUserById({ user_id: userId }, (error, response) => {
        // ← SỬA: đổi id thành user_id
        if (error) {
          console.error('ChatbotService UserClient: Error getting user:', error)
          resolve(null)
        } else {
          resolve(response) // ← SỬA: user.proto trả về UserResponse trực tiếp, không có .user
        }
      })
    })
  }

  async getAllUsers () {
    return new Promise((resolve, reject) => {
      // User service không có GetAllUsers method, return empty array
      console.warn(
        'ChatbotService UserClient: GetAllUsers not available in UserService proto'
      )
      resolve([])
    })
  }

  async searchUsers (query) {
    return new Promise((resolve, reject) => {
      // User service không có SearchUsers method, return empty array
      console.warn(
        'ChatbotService UserClient: SearchUsers not available in UserService proto'
      )
      resolve([])
    })
  }
}

module.exports = new UserClient()
