require('dotenv').config() // Nên đặt ở dòng đầu tiên
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const userServiceHandlers = require('./handlers/userServiceHandlers') // Giả sử file này export đúng các handler
const Consul = require('consul') // Import Consul

const PORT = process.env.PORT || 50052
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = 'user-service' // Định nghĩa tên service rõ ràng

// Đường dẫn tới file user.proto
// process.cwd() sẽ là /usr/src/app (WORKDIR)
// Thư mục protos được copy vào /usr/src/app/protos
const USER_PROTO_PATH = path.join(process.cwd(), 'protos', 'user.proto')
console.log(
  `User-Service: Attempting to load proto file from: ${USER_PROTO_PATH}`
)

const packageDefinition = protoLoader.loadSync(USER_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const userProto = grpc.loadPackageDefinition(packageDefinition).user // 'user' là package name trong user.proto

async function main () {
  if (!MONGO_URI) {
    console.error(`FATAL ERROR for ${SERVICE_NAME}: MONGO_URI is not defined.`)
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
  server.addService(userProto.UserService.service, userServiceHandlers)

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
      // SERVICE_ADDRESS nên là tên mà các service khác có thể dùng để resolve trong Docker network
      // Thường thì đây chính là tên service được định nghĩa trong docker-compose.yml
      const serviceAddressForConsul = SERVICE_NAME // Ví dụ: 'user-service'
      const serviceId = `${SERVICE_NAME}-${serviceAddressForConsul}-${port}`

      const check = {
        name: `gRPC health check for ${SERVICE_NAME}`,
        // Consul sẽ cố gắng kết nối tới service này trên port này để check health
        // Địa chỉ 'serviceAddressForConsul' phải có thể được resolve bởi Consul agent
        grpc: `${serviceAddressForConsul}:${port}`,
        interval: '10s',
        timeout: '5s',
        deregistercriticalserviceafter: '1m'
      }

      consul.agent.service
        .register({
          name: SERVICE_NAME,
          id: serviceId,
          address: serviceAddressForConsul, // Service khác sẽ dùng tên này để tìm IP qua Consul DNS
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
          server.forceShutdown() // Đảm bảo server tắt hẳn
          process.exit(0)
        }
      })
    }
  )
}

main()
