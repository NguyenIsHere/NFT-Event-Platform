require('dotenv').config() // Nên đặt ở dòng đầu tiên
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const authServiceHandlers = require('./handlers/authServiceHandlers') // Giả sử file này export đúng các handler
const Consul = require('consul') // Import Consul

const PORT = process.env.PORT || 50050
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = 'auth-service' // Định nghĩa tên service rõ ràng

// Đường dẫn tới file auth.proto
const AUTH_PROTO_PATH = path.join(process.cwd(), 'protos', 'auth.proto')
console.log(
  `Auth-Service: Attempting to load proto file from: ${AUTH_PROTO_PATH}`
)

// Auth-service cũng cần user.proto để gọi UserServiceClient
// Bạn cần đảm bảo user.proto cũng được copy vào /usr/src/app/protos trong Dockerfile của auth-service
const USER_PROTO_PATH = path.join(process.cwd(), 'protos', 'user.proto')

const authPackageDefinition = protoLoader.loadSync(AUTH_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const authProto = grpc.loadPackageDefinition(authPackageDefinition).auth // 'auth' là package name

// Đoạn này để client của auth-service (nếu có) hoặc chính nó gọi UserService
// Nó đã được xử lý trong src/clients/userServiceClient.js, không cần load lại ở đây
// nếu userServiceClient.js đã được cấu hình đúng để load user.proto.

async function main () {
  if (!MONGO_URI) {
    console.error(`FATAL ERROR for ${SERVICE_NAME}: MONGO_URI is not defined.`)
    process.exit(1)
  }
  if (!process.env.JWT_SECRET) {
    console.error(`FATAL ERROR for ${SERVICE_NAME}: JWT_SECRET is not defined.`)
    process.exit(1)
  }

  try {
    await mongoose.connect(MONGO_URI)
    console.log(`MongoDB connected successfully for ${SERVICE_NAME}`)
  } catch (err) {
    console.error(`MongoDB connection error for ${SERVICE_NAME}:`, err)
    process.exit(1)
  }

  const server = new grpc.Server()
  server.addService(authProto.AuthService.service, authServiceHandlers)

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        return
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${port}`)
      server.start()

      // Đăng ký với Consul
      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForConsul = SERVICE_NAME // Ví dụ: 'auth-service'
      const serviceId = `${SERVICE_NAME}-${serviceAddressForConsul}-${port}`

      const check = {
        name: `gRPC health check for ${SERVICE_NAME}`,
        grpc: `${serviceAddressForConsul}:${port}`,
        interval: '10s',
        timeout: '5s',
        deregistercriticalserviceafter: '1m'
      }

      consul.agent.service
        .register({
          name: SERVICE_NAME,
          id: serviceId,
          address: serviceAddressForConsul,
          port: parseInt(PORT),
          tags: ['grpc', 'nodejs', SERVICE_NAME],
          check: check
        })
        .then(() => {
          console.log(
            `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul on address ${serviceAddressForConsul}:${PORT}`
          )
        })
        .catch(errConsul => {
          console.error(
            `Failed to register ${SERVICE_NAME} with Consul:`,
            errConsul
          )
        })

      process.on('SIGINT', async () => {
        console.log(`Deregistering ${serviceId} from Consul...`)
        try {
          await consul.agent.service.deregister(serviceId)
          console.log(`${serviceId} deregistered.`)
        } catch (deregisterErr) {
          console.error(`Error deregistering ${serviceId}:`, deregisterErr)
        } finally {
          server.forceShutdown()
          process.exit(0)
        }
      })
    }
  )
}

main()
