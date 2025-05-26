// src/server.js
// Đảm bảo .env được load đúng cách từ thư mục gốc của service (08-ipfs-service/.env)
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const os = require('os') // Thêm module 'os'
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const Consul = require('consul')
const { v4: uuidv4 } = require('uuid')

const ipfsServiceHandlers = require('./handlers/ipfsServiceHandlers')

const PORT = process.env.PORT || 50058 // Port cho ipfs-service
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'ipfs-service'
const SERVICE_TYPE = process.env.SERVICE_TYPE

// Hàm lấy IP động của service, giống như bạn đã dùng cho user-service
function getServiceIP () {
  const interfaces = os.networkInterfaces()
  // Ưu tiên IP thuộc Docker network (ví dụ: 172.23.x.x)
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      // Đổi tên biến 'interface' để tránh trùng từ khóa
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        if (interfaceInfo.address.startsWith('172.23.')) {
          // Điều chỉnh prefix này nếu dải IP Docker của bạn khác
          return interfaceInfo.address
        }
      }
    }
  }
  // Fallback: Lấy IP IPv4 non-internal đầu tiên tìm thấy
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
        return interfaceInfo.address
      }
    }
  }
  console.warn(
    `${SERVICE_NAME}: Could not find a suitable IPv4 address starting with "172.23.". Falling back to any non-internal IPv4.`
  )
  // Nếu vẫn không tìm thấy, có thể throw error hoặc trả về một default nào đó
  // throw new Error('Cannot find suitable IP address for service registration');
  return '127.0.0.1' // Hoặc một fallback an toàn hơn nếu không tìm thấy IP mong muốn
}

if (SERVICE_TYPE !== 'ipfs') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'ipfs' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}
if (
  !process.env.PINATA_JWT &&
  (!process.env.PINATA_API_KEY || !process.env.PINATA_API_SECRET)
) {
  console.error(
    `FATAL ERROR: Pinata credentials (JWT or API Key/Secret) are not defined in .env for ${SERVICE_NAME}.`
  )
  process.exit(1)
}

const PROTOS_ROOT_DIR = path.resolve(__dirname, '..', 'protos')
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
  includeDirs: [PROTOS_ROOT_DIR]
})

const ipfsProto = grpc.loadPackageDefinition(ipfsPackageDefinition).ipfs

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

    // Địa chỉ dùng cho target của gRPC health check (Consul sẽ phân giải tên này qua Docker DNS)
    const serviceAddressForCheckTarget = SERVICE_NAME
    const servicePortForCheckTarget = parseInt(PORT)

    const check = {
      name: `gRPC health check for ${SERVICE_NAME} (${serviceId})`,
      // Target cho gRPC health check của Consul sẽ là <service_name>:<port>
      // Consul agent sẽ tự phân giải SERVICE_NAME (ví dụ 'ipfs-service') qua Docker DNS
      // để tìm IP của container này rồi thực hiện check.
      grpc: `${serviceAddressForCheckTarget}:${servicePortForCheckTarget}`,
      interval: '10s',
      timeout: '5s',
      deregistercriticalserviceafter: '1m'
    }

    // Lấy IP động của container này để đăng ký với Consul
    const actualServiceIP = getServiceIP()
    console.log(
      `${SERVICE_NAME}: Determined service IP for Consul registration: ${actualServiceIP}`
    )

    consul.agent.service
      .register({
        name: SERVICE_NAME,
        id: serviceId,
        address: actualServiceIP, // Sử dụng IP động đã lấy được
        port: parseInt(PORT),
        tags: ['grpc', 'nodejs', SERVICE_NAME, 'storage', 'ipfs'],
        check: check
      })
      .then(() => {
        // Log ra IP mà service đã đăng ký
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
