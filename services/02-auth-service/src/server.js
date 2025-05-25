require('dotenv').config()
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const authServiceHandlers = require('./handlers/authServiceHandlers')
const Consul = require('consul')
const crypto = require('crypto')

// Import từ grpc-health-check
const health = require('grpc-health-check')
const HealthService = health.service
const HealthImplementation = health.HealthImplementation

// Biến môi trường và hằng số
const SERVICE_TYPE = process.env.SERVICE_TYPE // Sẽ là 'auth'
const PORT = process.env.PORT || 50051
const MONGO_URI = process.env.MONGO_URI
const JWT_SECRET = process.env.JWT_SECRET
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = 'auth-service' // Tên service để đăng ký với Consul

if (SERVICE_TYPE !== 'auth') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'auth' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const AUTH_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'auth.proto')

console.log(
  `${SERVICE_NAME}: Attempting to load proto file from: ${AUTH_PROTO_PATH}`
)

const authPackageDefinition = protoLoader.loadSync(AUTH_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})
const authProto = grpc.loadPackageDefinition(authPackageDefinition).auth

// Tạo health check service status map
const statusMap = {
  '': 'NOT_SERVING', // Trạng thái chung của server
  [SERVICE_NAME]: 'NOT_SERVING' // Trạng thái cho service cụ thể "auth-service"
  // Bạn cũng có thể dùng tên đầy đủ từ proto nếu muốn Consul check bằng tên đó, ví dụ:
  // "auth.AuthService": 'NOT_SERVING',
}
const grpcHealthCheck = new HealthImplementation(statusMap)

async function main () {
  if (!MONGO_URI) {
    console.error(`FATAL ERROR for ${SERVICE_NAME}: MONGO_URI is not defined.`)
    process.exit(1)
  }
  if (!JWT_SECRET) {
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
  server.addService(HealthService, grpcHealthCheck) // Thêm health service vào server

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        return
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${boundPort}`)
      server.start()

      // Cập nhật trạng thái health check sau khi server start
      grpcHealthCheck.setStatus('', 'SERVING')
      grpcHealthCheck.setStatus(SERVICE_NAME, 'SERVING')
      // grpcHealthCheck.setStatus("auth.AuthService", 'SERVING'); // Nếu bạn khai báo key này trong statusMap
      console.log(
        `${SERVICE_NAME} health status set to SERVING for "" and "${SERVICE_NAME}".`
      )

      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForConsul = SERVICE_NAME
      const instanceId =
        process.env.HOSTNAME || crypto.randomBytes(8).toString('hex')
      // Sử dụng PORT (đã parse) cho serviceId và check, vì đây là port đã biết trước
      const servicePortForConsul = parseInt(PORT)
      const serviceId = `${SERVICE_NAME}-${instanceId}-${boundPort}`

      const check = {
        name: `gRPC health check for ${SERVICE_NAME} (${instanceId})`,
        grpc: `${serviceAddressForConsul}:${servicePortForConsul}`, // Consul sẽ check service health này
        // grpc_use_tls: false, // Mặc định là false, chỉ cần nếu gRPC service của bạn dùng TLS
        interval: '10s',
        timeout: '10s', // Thời gian Consul chờ phản hồi từ health check
        deregistercriticalserviceafter: '1m'
      }

      // Trong server.js, phần đăng ký Consul
      // const check = {
      //   name: `TCP check for ${SERVICE_NAME} (${instanceId})`,
      //   // SỬ DỤNG servicePortForConsul (là PORT đã được parseInt)
      //   tcp: `${serviceAddressForConsul}:${servicePortForConsul}`, // <<< SỬA Ở ĐÂY
      //   interval: '10s',
      //   timeout: '1s', // Có thể tăng timeout lên một chút, ví dụ 2s hoặc 3s
      //   deregistercriticalserviceafter: '1m'
      // }

      consul.agent.service
        .register({
          name: SERVICE_NAME, // Tên này sẽ được Consul dùng trong HealthCheckRequest.service
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
        console.log(
          `Deregistering ${serviceId} from Consul for ${SERVICE_NAME}...`
        )
        grpcHealthCheck.setStatus('', 'NOT_SERVING')
        grpcHealthCheck.setStatus(SERVICE_NAME, 'NOT_SERVING')
        // grpcHealthCheck.setStatus("auth.AuthService", 'NOT_SERVING');
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
