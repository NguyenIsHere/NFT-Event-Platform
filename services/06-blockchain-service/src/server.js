// src/server.js (cho 06-blockchain-service)
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const os = require('os')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const Consul = require('consul')
const crypto = require('crypto')

const healthCheck = require('grpc-health-check')
const HealthImplementation = healthCheck.HealthImplementation

const blockchainServiceHandlers = require('./handlers/blockchainServiceHandlers')

const SERVICE_TYPE = process.env.SERVICE_TYPE
const PORT = process.env.PORT || 50056 // Port cho blockchain-service
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'blockchain-service'

function getServiceIP () {
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
          `${SERVICE_NAME}: Falling back to IP ${interfaceInfo.address} as no 172.23.x.x IP was found.`
        )
        return interfaceInfo.address
      }
    }
  }
  console.error(
    `${SERVICE_NAME}: FATAL ERROR - Cannot find any suitable IPv4 address for service registration.`
  )
  throw new Error('Cannot find suitable IP address for service registration')
}

if (SERVICE_TYPE !== 'blockchain') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'blockchain' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}
if (
  !process.env.ETHEREUM_RPC_URL ||
  !process.env.SIGNER_PRIVATE_KEY ||
  !process.env.EVENT_TICKET_NFT_CONTRACT_ADDRESS
) {
  console.error(
    `FATAL ERROR: Ethereum configuration (RPC_URL, SIGNER_PRIVATE_KEY, EVENT_TICKET_NFT_CONTRACT_ADDRESS) is not fully defined in .env for ${SERVICE_NAME}.`
  )
  process.exit(1)
}

const PROTOS_ROOT_DIR_IN_CONTAINER = path.join(process.cwd(), 'protos')
const BLOCKCHAIN_PROTO_PATH = path.join(
  PROTOS_ROOT_DIR_IN_CONTAINER,
  'blockchain.proto'
)

console.log(
  `${SERVICE_NAME}: Attempting to load main proto file from: ${BLOCKCHAIN_PROTO_PATH}`
)
const mainPackageDefinition = protoLoader.loadSync(BLOCKCHAIN_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER]
})

const blockchainProto = grpc.loadPackageDefinition(
  mainPackageDefinition
).blockchain // package blockchain;
const MainServiceDefinitionFromProto = blockchainProto.BlockchainService.service

const statusMap = {
  '': 'NOT_SERVING',
  [SERVICE_NAME]: 'NOT_SERVING'
}
const healthImplementation = new HealthImplementation(statusMap)

async function main () {
  const server = new grpc.Server()
  server.addService(MainServiceDefinitionFromProto, blockchainServiceHandlers)
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
      console.log(
        `${SERVICE_NAME} health status set to SERVING for "" and "${SERVICE_NAME}".`
      )

      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
      const serviceAddressForCheckTarget = SERVICE_NAME
      const servicePortForCheckTarget = parseInt(PORT)
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
          tags: ['grpc', 'nodejs', SERVICE_NAME, 'blockchain'],
          check: check
        })
        .then(() => {
          console.log(
            `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul on address ${actualServiceIP}:${PORT}. Health check target: ${serviceAddressForCheckTarget}:${servicePortForCheckTarget}`
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
    }
  )
}

main().catch(error => {
  console.error(`${SERVICE_NAME} failed to start:`, error)
  process.exit(1)
})
