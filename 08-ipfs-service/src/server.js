// src/server.js
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env')
}) // Load .env từ thư mục gốc của service
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const Consul = require('consul')
const { v4: uuidv4 } = require('uuid')

const ipfsServiceHandlers = require('./handlers/ipfsServiceHandlers') // Đường dẫn mới

const PORT = process.env.PORT || 50058
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'ipfs-service'
const SERVICE_TYPE = process.env.SERVICE_TYPE // Bạn nên đặt SERVICE_TYPE=ipfs trong .env

if (SERVICE_TYPE !== 'ipfs') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'ipfs' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}
if (!process.env.PINATA_JWT) {
  console.error(
    `FATAL ERROR: PINATA_JWT is not defined in .env for ${SERVICE_NAME}.`
  )
  process.exit(1)
}

// Đường dẫn đến thư mục protos chung của dự án
// server.js bây giờ nằm trong src/, nên cần đi lên 2 cấp để ra gốc dự án, rồi vào protos/
const PROTOS_ROOT_DIR = path.resolve(__dirname, '..', '..', 'protos')
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ipfs.proto')

console.log(
  `${SERVICE_NAME}: Attempting to load proto file from: ${IPFS_PROTO_PATH}`
)
const ipfsPackageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR] // Cho phép import google/api/annotations.proto
})

const ipfsProto = grpc.loadPackageDefinition(ipfsPackageDefinition).ipfs // package ipfs;

const server = new grpc.Server()
server.addService(ipfsProto.IpfsService.service, ipfsServiceHandlers)

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

    const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
    const serviceId = `${SERVICE_NAME}-${uuidv4()}-${boundPort}`

    // Sử dụng hàm getServiceIP của bạn nếu muốn đăng ký bằng IP, hoặc dùng SERVICE_NAME
    // const serviceIP = getServiceIP(); // Hàm này bạn đã dùng ở service khác

    const check = {
      name: `TCP check for ${SERVICE_NAME} (${serviceId})`,
      tcp: `localhost:${boundPort}`, // Hoặc serviceIP + port nếu dùng getServiceIP()
      interval: '10s',
      timeout: '5s',
      deregistercriticalserviceafter: '1m'
    }

    consul.agent.service
      .register({
        name: SERVICE_NAME,
        id: serviceId,
        address: SERVICE_NAME, // Hoặc serviceIP
        port: parseInt(PORT),
        tags: ['grpc', 'nodejs', SERVICE_NAME, 'storage', 'ipfs'],
        check: check
      })
      .then(() => {
        console.log(
          `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul.`
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
