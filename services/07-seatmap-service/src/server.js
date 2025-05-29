// 07-seatmap-service/src/server.js
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const os = require('os')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const Consul = require('consul')
const crypto = require('crypto')
const healthCheck = require('grpc-health-check')
const HealthImplementation = healthCheck.HealthImplementation

const seatMapServiceHandlers = require('./handlers/seatMapServiceHandlers')

const SERVICE_TYPE = process.env.SERVICE_TYPE // 'seatmap'
const PORT = process.env.PORT || 50057
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'seatmap-service'

function getServiceIP () {
  /* ... (copy hàm getServiceIP từ service khác) ... */
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        if (interfaceInfo.address.startsWith('172.23.')) {
          return interfaceInfo.address
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        console.warn(
          `${SERVICE_NAME}: Falling back to IP ${interfaceInfo.address}`
        )
        return interfaceInfo.address
      }
    }
  }
  throw new Error('Cannot find suitable IP address')
}

if (SERVICE_TYPE !== 'seatmap') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env for ${SERVICE_NAME}. Expected 'seatmap', got '${SERVICE_TYPE}'`
  )
  process.exit(1)
}
if (!MONGO_URI) {
  console.error(`FATAL ERROR for ${SERVICE_NAME}: MONGO_URI is not defined.`)
  process.exit(1)
}

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos') // Sử dụng process.cwd()
const SEATMAP_PROTO_PATH = path.join(
  PROTOS_ROOT_DIR_IN_CONTAINER,
  'seatmap.proto'
)

console.log(`${SERVICE_NAME}: Loading proto from ${SEATMAP_PROTO_PATH}`)
const mainPackageDefinition = protoLoader.loadSync(SEATMAP_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})
const seatmapProto = grpc.loadPackageDefinition(mainPackageDefinition).seatmap // package 'seatmap'
const MainServiceDefinitionFromProto = seatmapProto.SeatMapService.service // Sửa thành SeatMapService

const statusMap = { '': 'NOT_SERVING', [SERVICE_NAME]: 'NOT_SERVING' }
const healthImplementation = new HealthImplementation(statusMap)

async function main () {
  try {
    await mongoose.connect(MONGO_URI)
    console.log(`MongoDB connected successfully for ${SERVICE_NAME}`)
  } catch (err) {
    console.error(`MongoDB connection error for ${SERVICE_NAME}:`, err)
    process.exit(1)
  }

  const server = new grpc.Server()
  server.addService(MainServiceDefinitionFromProto, seatMapServiceHandlers)
  healthImplementation.addToServer(server)

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        process.exit(1)
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${boundPort}`)
      // server.start(); // Bỏ dòng này

      healthImplementation.setStatus('', 'SERVING')
      healthImplementation.setStatus(SERVICE_NAME, 'SERVING')
      console.log(`${SERVICE_NAME} health status set to SERVING.`)

      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForCheckTarget = SERVICE_NAME
      const servicePortForCheckTarget = parseInt(PORT)
      const instanceId =
        process.env.HOSTNAME || crypto.randomBytes(8).toString('hex')
      const serviceId = `${SERVICE_NAME}-${instanceId}-${boundPort}`
      const actualServiceIP = getServiceIP()

      const check = {
        name: `gRPC health check for ${SERVICE_NAME} (${instanceId})`,
        grpc: `${serviceAddressForCheckTarget}:${servicePortForCheckTarget}`,
        interval: '10s',
        timeout: '5s',
        deregistercriticalserviceafter: '1m'
      }

      consul.agent.service
        .register({
          name: SERVICE_NAME,
          id: serviceId,
          address: actualServiceIP,
          port: parseInt(PORT),
          tags: ['grpc', 'nodejs', SERVICE_NAME, 'seatmap'],
          check: check
        })
        .then(() => {
          console.log(
            `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul on ${actualServiceIP}:${PORT}.`
          )
        })
        .catch(errConsul => {
          console.error(
            `Failed to register ${SERVICE_NAME} with Consul:`,
            errConsul
          )
        })

      process.on('SIGINT', async () => {
        /* ... (SIGINT handler giống các service khác) ... */
        console.log(
          `Deregistering ${serviceId} from Consul for ${SERVICE_NAME}...`
        )
        healthImplementation.setStatus('', 'NOT_SERVING')
        healthImplementation.setStatus(SERVICE_NAME, 'NOT_SERVING')
        try {
          await consul.agent.service.deregister(serviceId)
          console.log(`${serviceId} deregistered.`)
        } catch (deregisterErr) {
          console.error(`Error deregistering ${serviceId}:`, deregisterErr)
        } finally {
          server.forceShutdown()
          console.log(`${SERVICE_NAME} server shutdown.`)
          process.exit(0)
        }
      })
    }
  )
}

main().catch(error => {
  console.error(`${SERVICE_NAME} failed to start:`, error)
  process.exit(1)
})
