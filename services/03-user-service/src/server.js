require('dotenv').config()
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const userServiceHandlers = require('./handlers/userServiceHandlers')

const PORT = process.env.PORT || 50052
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul' // Địa chỉ Consul agent

// Đường dẫn tới file user.proto (sẽ được copy vào /usr/src/app/protos/user.proto bởi Docker)
const USER_PROTO_PATH = path.resolve(process.cwd(), 'protos', 'user.proto')

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
    console.error('FATAL ERROR: MONGO_URI is not defined.')
    process.exit(1)
  }

  try {
    await mongoose.connect(MONGO_URI)
    console.log('MongoDB connected successfully to user-service')
  } catch (err) {
    console.error('MongoDB connection error:', err)
    process.exit(1)
  }

  const server = new grpc.Server()
  server.addService(userProto.UserService.service, userServiceHandlers)

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('Failed to bind server:', err)
        return
      }
      console.log(`User gRPC Service running on port ${port}`)
      server.start()

      // TODO: Implement Consul registration logic here
      // Ví dụ:
      const consul = require('consul')({ host: CONSUL_AGENT_HOST })
      const serviceName = 'user-service'
      const serviceId = `${serviceName}-${port}` // Đảm bảo ID là duy nhất
      consul.agent.service.register(
        {
          name: serviceName,
          id: serviceId,
          address: 'user-service', // Tên service trong Docker network
          port: parseInt(PORT),
          check: {
            grpc: `user-service:${PORT}`, // Địa chỉ check gRPC health (cần gRPC health check protocol)
            interval: '10s',
            timeout: '5s',
            deregistercriticalserviceafter: '1m'
          }
        },
        err => {
          if (err) console.error('Failed to register service with Consul:', err)
          else console.log(`Service ${serviceName} registered with Consul`)
        }
      )
    }
  )
}

main()
