require('dotenv').config()
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const authServiceHandlers = require('./handlers/authServiceHandlers')
const Consul = require('consul')
const crypto = require('crypto')
const os = require('os')

function getServiceIP () {
  const interfaces = os.networkInterfaces()

  // Ưu tiên IP thuộc Docker network
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        if (interface.address.startsWith('172.23.')) {
          return interface.address
        }
      }
    }
  }

  // Fallback
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        return interface.address
      }
    }
  }

  throw new Error('Cannot find suitable IP address')
}

// Import từ grpc-health-check
const healthCheck = require('grpc-health-check')
const HealthImplementation = healthCheck.HealthImplementation // Đúng tên class constructor

// Biến môi trường và hằng số
const SERVICE_TYPE = process.env.SERVICE_TYPE // Sẽ là 'auth'
const PORT = process.env.PORT || 50051
const MONGO_URI = process.env.MONGO_URI
const JWT_SECRET = process.env.JWT_SECRET
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = 'auth-service'

if (SERVICE_TYPE !== 'auth') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'auth' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')

// Load file proto chính của auth-service
const AUTH_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'auth.proto')
console.log(
  `${SERVICE_NAME}: Attempting to load main proto file from: ${AUTH_PROTO_PATH}`
)
const authPackageDefinition = protoLoader.loadSync(AUTH_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER] // Cho phép import google/api/annotations.proto
})
const authProto = grpc.loadPackageDefinition(authPackageDefinition).auth // 'auth' là package name
const MainServiceDefinitionFromProto = authProto.AuthService.service

// Tạo health check service status map sử dụng string literals
const statusMap = {
  '': 'NOT_SERVING',
  [SERVICE_NAME]: 'NOT_SERVING'
  // "auth.AuthService": 'NOT_SERVING', // Tùy chọn: nếu muốn Consul check bằng tên đầy đủ
}
const healthImplementation = new HealthImplementation(statusMap)

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
  server.addService(MainServiceDefinitionFromProto, authServiceHandlers)
  healthImplementation.addToServer(server) // <--- Sử dụng phương thức của thư viện

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        return
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${boundPort}`)

      healthImplementation.setStatus('', 'SERVING')
      healthImplementation.setStatus(SERVICE_NAME, 'SERVING')
      // healthImplementation.setStatus("auth.AuthService", 'SERVING');
      console.log(
        `${SERVICE_NAME} health status set to SERVING for "" and "${SERVICE_NAME}".`
      )

      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForConsul = SERVICE_NAME
      // const serviceAddressForConsul = '172.23.0.3'
      const instanceId =
        process.env.HOSTNAME || crypto.randomBytes(8).toString('hex')
      const servicePortForConsul = parseInt(PORT)
      const serviceId = `${SERVICE_NAME}-${instanceId}-${servicePortForConsul}`

      const check = {
        name: `gRPC health check for ${SERVICE_NAME} (${instanceId})`,
        grpc: `${serviceAddressForConsul}:${servicePortForConsul}`,
        interval: '10s',
        timeout: '5s',
        deregistercriticalserviceafter: '1m'
      }

      const serviceIP = getServiceIP()

      consul.agent.service
        .register({
          name: SERVICE_NAME,
          id: serviceId,
          // address: serviceAddressForConsul,
          address: serviceIP,
          port: servicePortForConsul,
          tags: ['grpc', 'nodejs', SERVICE_NAME],
          check: check
        })
        .then(() => {
          console.log(
            `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul on address ${serviceAddressForConsul}:${servicePortForConsul}`
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
        healthImplementation.setStatus('', 'NOT_SERVING')
        healthImplementation.setStatus(SERVICE_NAME, 'NOT_SERVING')
        // healthImplementation.setStatus("auth.AuthService", 'NOT_SERVING');
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
