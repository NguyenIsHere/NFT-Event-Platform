// 04-event-service/src/server.js
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

const eventServiceHandlers = require('./handlers/eventServiceHandlers')
const eventStatusUpdater = require('./jobs/eventStatusUpdater')

const SERVICE_TYPE = process.env.SERVICE_TYPE
const PORT = process.env.PORT || 50054
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'event-service'

function getServiceIP () {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        if (interfaceInfo.address.startsWith('172.23.')) {
          // Điều chỉnh nếu cần
          return interfaceInfo.address
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        console.warn(
          `${SERVICE_NAME}: Fallback: Using IP ${interfaceInfo.address}`
        )
        return interfaceInfo.address
      }
    }
  }
  console.error(
    `${SERVICE_NAME}: FATAL ERROR - Cannot find suitable IPv4 address.`
  )
  throw new Error('Cannot find suitable IP address')
}

if (SERVICE_TYPE !== 'event') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env for ${SERVICE_NAME}. Expected 'event', got '${SERVICE_TYPE}'`
  )
  process.exit(1)
}
if (!MONGO_URI) {
  console.error(`FATAL ERROR for ${SERVICE_NAME}: MONGO_URI is not defined.`)
  process.exit(1)
}
// Kiểm tra các biến môi trường cho gRPC clients
if (!process.env.IPFS_SERVICE_ADDRESS) {
  console.warn(
    `WARNING for ${SERVICE_NAME}: IPFS_SERVICE_ADDRESS is not defined in .env. Calls to IPFS service may fail.`
  )
}
if (!process.env.BLOCKCHAIN_SERVICE_ADDRESS) {
  console.warn(
    `WARNING for ${SERVICE_NAME}: BLOCKCHAIN_SERVICE_ADDRESS is not defined in .env. Calls to Blockchain service may fail.`
  )
}

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const EVENT_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'event.proto')

console.log(`${SERVICE_NAME}: Loading proto from ${EVENT_PROTO_PATH}`)
const mainPackageDefinition = protoLoader.loadSync(EVENT_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})
const eventProto = grpc.loadPackageDefinition(mainPackageDefinition).event // package 'event'
const MainServiceDefinitionFromProto = eventProto.EventService.service

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
  server.addService(MainServiceDefinitionFromProto, eventServiceHandlers)
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
      server.start()

      healthImplementation.setStatus('', 'SERVING')
      healthImplementation.setStatus(SERVICE_NAME, 'SERVING')
      console.log(`${SERVICE_NAME} health status set to SERVING.`)

      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForCheckTarget = SERVICE_NAME
      const servicePortForCheckTarget = parseInt(PORT)
      const instanceId =
        process.env.HOSTNAME || crypto.randomBytes(8).toString('hex')
      const serviceId = `${SERVICE_NAME}-${instanceId}-${boundPort}`

      let actualServiceIP
      try {
        actualServiceIP = getServiceIP()
        console.log(
          `${SERVICE_NAME}: Determined service IP for Consul registration: ${actualServiceIP}`
        )
      } catch (ipError) {
        console.error(`${SERVICE_NAME}: ${ipError.message}. Exiting.`)
        process.exit(1)
      }

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
          tags: ['grpc', 'nodejs', SERVICE_NAME, 'event'],
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
        console.log(
          `Deregistering ${serviceId} from Consul for ${SERVICE_NAME}...`
        )
        healthImplementation.setStatus('', 'NOT_SERVING')
        healthImplementation.setStatus(SERVICE_NAME, 'NOT_SERVING')
        try {
          await consul.agent.service.deregister(serviceId)
          console.log(`${serviceId} deregistered from Consul.`)
        } catch (deregisterErr) {
          console.error(
            `Error deregistering ${serviceId} from Consul:`,
            deregisterErr
          )
        } finally {
          console.log(`Shutting down ${SERVICE_NAME} gRPC server...`)
          server.forceShutdown()
          console.log(`${SERVICE_NAME} server shutdown complete.`)
          process.exit(0)
        }
      })
      // ✅ START: Event status updater cron job
      eventStatusUpdater.start()
    }
  )
}

main().catch(error => {
  console.error(`${SERVICE_NAME} failed to start:`, error)
  process.exit(1)
})
