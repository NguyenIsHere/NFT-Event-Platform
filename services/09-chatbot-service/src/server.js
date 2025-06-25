require('dotenv').config()
const express = require('express')
const cors = require('cors')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const Consul = require('consul')
const crypto = require('crypto')
const os = require('os')
const path = require('path')

// Import handlers and utils
const chatbotHandlers = require('./handlers/chatbotHandlers')
const { initializeVectorDB } = require('./utils/vectorUtils')
const {
  indexExistingData,
  schedulePeriodicIndexing
} = require('./services/dataIndexer')

// Import từ grpc-health-check
const healthCheck = require('grpc-health-check')
const HealthImplementation = healthCheck.HealthImplementation

// Constants
const SERVICE_TYPE = process.env.SERVICE_TYPE
const PORT = process.env.PORT || 50059
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'chatbot-service'

if (SERVICE_TYPE !== 'chatbot') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'chatbot' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}

function getServiceIP () {
  const interfaces = os.networkInterfaces()
  // Ưu tiên IP thuộc Docker network (ví dụ: 172.23.x.x)
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        if (interfaceInfo.address.startsWith('172.23.')) {
          return interfaceInfo.address
        }
      }
    }
  }
  // Fallback: Lấy IP IPv4 non-internal đầu tiên tìm thấy
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

// Load proto
const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const CHATBOT_PROTO_PATH = path.join(
  PROTOS_ROOT_DIR_IN_CONTAINER,
  'chatbot.proto'
)

console.log(`${SERVICE_NAME}: Loading proto from ${CHATBOT_PROTO_PATH}`)
const packageDefinition = protoLoader.loadSync(CHATBOT_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})

const chatbotProto = grpc.loadPackageDefinition(packageDefinition).chatbot
const MainServiceDefinitionFromProto = chatbotProto.ChatbotService.service

// Tạo health check service status map
const statusMap = {
  '': 'NOT_SERVING',
  [SERVICE_NAME]: 'NOT_SERVING'
}
const healthImplementation = new HealthImplementation(statusMap)

async function main () {
  // Connect to MongoDB
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

  // Initialize Vector Database
  console.log('Initializing vector database...')
  await initializeVectorDB()

  // Setup gRPC server
  const server = new grpc.Server()
  server.addService(MainServiceDefinitionFromProto, chatbotHandlers)
  healthImplementation.addToServer(server)

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    async (err, boundPort) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        return
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${boundPort}`)
      server.start()

      // Cập nhật trạng thái health check sau khi server bind thành công
      healthImplementation.setStatus('', 'SERVING')
      healthImplementation.setStatus(SERVICE_NAME, 'SERVING')

      // Index existing data on startup (với delay để các service khác ready)
      setTimeout(async () => {
        console.log('Starting initial data indexing...')
        try {
          await indexExistingData()
          console.log('Initial data indexing completed')

          // Setup periodic indexing
          schedulePeriodicIndexing()
        } catch (error) {
          console.error('Initial data indexing failed:', error)
        }
      }, 10000) // Wait 10 seconds for other services to be ready

      // Đăng ký với Consul
      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })

      // Target cho gRPC health check của Consul
      const serviceAddressForCheckTarget = SERVICE_NAME
      const servicePortForCheckTarget = parseInt(PORT)

      // Tạo instanceId
      const instanceId =
        process.env.HOSTNAME || crypto.randomBytes(8).toString('hex')
      const serviceId = `${SERVICE_NAME}-${instanceId}-${boundPort}`

      const check = {
        name: `gRPC health check for ${SERVICE_NAME} (${instanceId})`,
        grpc: `${serviceAddressForCheckTarget}:${servicePortForCheckTarget}`,
        interval: '10s',
        timeout: '5s',
        deregistercriticalserviceafter: '1m'
      }

      // Lấy IP động của container
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

      consul.agent.service
        .register({
          name: SERVICE_NAME,
          id: serviceId,
          address: actualServiceIP,
          port: parseInt(PORT),
          tags: ['grpc', 'nodejs', SERVICE_NAME, 'chatbot'],
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
          console.log(`${serviceId} deregistered.`)
        } catch (deregisterErr) {
          console.error(`Error deregistering ${serviceId}:`, deregisterErr)
        } finally {
          server.forceShutdown()
          console.log(`${SERVICE_NAME} server shutdown complete.`)
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
