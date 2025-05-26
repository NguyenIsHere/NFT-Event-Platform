// src/server.js (cho 08-ipfs-service)
// Đảm bảo .env được load đúng cách từ thư mục gốc của service (08-ipfs-service/.env)
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const os = require('os')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const Consul = require('consul')
const crypto = require('crypto') // Giống user-service, có thể dùng cho instanceId

// Import từ grpc-health-check (giống user-service)
const healthCheck = require('grpc-health-check')
const HealthImplementation = healthCheck.HealthImplementation

const ipfsServiceHandlers = require('./handlers/ipfsServiceHandlers')

// Biến môi trường và hằng số cho ipfs-service
const SERVICE_TYPE = process.env.SERVICE_TYPE // Sẽ là 'ipfs'
const PORT = process.env.PORT || 50058 // Port cho ipfs-service (theo quy ước mới)
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = process.env.SERVICE_NAME || 'ipfs-service' // Tên service

// Hàm lấy IP động của service, giống như bạn đã dùng cho user-service
function getServiceIP () {
  const interfaces = os.networkInterfaces()
  // Ưu tiên IP thuộc Docker network (ví dụ: 172.23.x.x)
  for (const name of Object.keys(interfaces)) {
    for (const interfaceInfo of interfaces[name]) {
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
        console.warn(
          `${SERVICE_NAME}: Falling back to IP ${interfaceInfo.address} as no 172.23.x.x IP was found.`
        )
        return interfaceInfo.address
      }
    }
  }
  // Nếu không tìm thấy IP nào phù hợp, có thể là vấn đề cấu hình mạng
  console.error(
    `${SERVICE_NAME}: FATAL ERROR - Cannot find any suitable IPv4 address for service registration.`
  )
  throw new Error('Cannot find suitable IP address for service registration')
}

if (SERVICE_TYPE !== 'ipfs') {
  console.error(
    `FATAL ERROR: SERVICE_TYPE in .env is not 'ipfs' for ${SERVICE_NAME}. Current: ${SERVICE_TYPE}`
  )
  process.exit(1)
}
// Kiểm tra Pinata credentials
if (
  !process.env.PINATA_JWT &&
  (!process.env.PINATA_API_KEY || !process.env.PINATA_API_SECRET)
) {
  console.error(
    `FATAL ERROR: Pinata credentials (JWT or API Key/Secret) are not defined in .env for ${SERVICE_NAME}.`
  )
  process.exit(1)
}

// Đường dẫn đến thư mục protos dùng chung của dự án
// server.js nằm trong src/, nên đi lên 2 cấp để ra gốc dự án, rồi vào protos/
const PROTOS_ROOT_DIR_IN_CONTAINER = path.resolve(__dirname, '..', 'protos')
const IPFS_PROTO_PATH = path.join(PROTOS_ROOT_DIR_IN_CONTAINER, 'ipfs.proto')

console.log(
  `${SERVICE_NAME}: Attempting to load main proto file from: ${IPFS_PROTO_PATH}`
)
const mainPackageDefinition = protoLoader.loadSync(IPFS_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR_IN_CONTAINER] // Cho phép import google/api/annotations.proto
})

const ipfsProto = grpc.loadPackageDefinition(mainPackageDefinition).ipfs // package ipfs;
const MainServiceDefinitionFromProto = ipfsProto.IpfsService.service

// Tạo health check service status map (giống user-service)
const statusMap = {
  '': 'NOT_SERVING', // Trạng thái chung của server
  [SERVICE_NAME]: 'NOT_SERVING' // Trạng thái của service chính
  // Bạn có thể thêm tên service đầy đủ nếu cần theo dõi riêng:
  // 'ipfs.IpfsService': 'NOT_SERVING'
}
const healthImplementation = new HealthImplementation(statusMap)

async function main () {
  // ipfs-service không cần kết nối MongoDB trực tiếp, nên bỏ qua phần mongoose.connect

  const server = new grpc.Server()
  server.addService(MainServiceDefinitionFromProto, ipfsServiceHandlers)
  healthImplementation.addToServer(server) // Thêm health check service vào server

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(`Failed to bind ${SERVICE_NAME} server:`, err)
        process.exit(1) // Thoát nếu không bind được port
      }
      console.log(`${SERVICE_NAME} gRPC Service running on port ${boundPort}`)
      server.start() // Khởi động server gRPC

      // Cập nhật trạng thái health check sau khi server bind thành công
      healthImplementation.setStatus('', 'SERVING')
      healthImplementation.setStatus(SERVICE_NAME, 'SERVING')
      // if (statusMap['ipfs.IpfsService'] !== undefined) {
      //     healthImplementation.setStatus('ipfs.IpfsService', 'SERVING');
      // }
      console.log(
        `${SERVICE_NAME} health status set to SERVING for "" and "${SERVICE_NAME}".`
      )

      // Đăng ký với Consul
      const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })

      // Target cho gRPC health check của Consul: sẽ dùng tên service để Docker DNS phân giải
      const serviceAddressForCheckTarget = SERVICE_NAME
      const servicePortForCheckTarget = parseInt(PORT)

      // Tạo instanceId giống như user-service
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

      // Lấy IP động của container này để đăng ký với Consul
      let actualServiceIP
      try {
        actualServiceIP = getServiceIP()
        console.log(
          `${SERVICE_NAME}: Determined service IP for Consul registration: ${actualServiceIP}`
        )
      } catch (ipError) {
        console.error(`${SERVICE_NAME}: ${ipError.message}. Exiting.`)
        process.exit(1) // Thoát nếu không lấy được IP
      }

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
          console.log(
            `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul on address ${actualServiceIP}:${PORT}. Health check target: ${serviceAddressForCheckTarget}:${servicePortForCheckTarget}`
          )
        })
        .catch(errConsul => {
          console.error(
            `Failed to register ${SERVICE_NAME} with Consul:`,
            errConsul
          )
          // Cân nhắc việc thoát nếu không đăng ký được Consul, tùy theo yêu cầu
        })

      process.on('SIGINT', async () => {
        console.log(
          `Deregistering ${serviceId} from Consul for ${SERVICE_NAME}...`
        )
        // Cập nhật trạng thái health check trước khi deregister (tùy chọn)
        healthImplementation.setStatus('', 'NOT_SERVING')
        healthImplementation.setStatus(SERVICE_NAME, 'NOT_SERVING')
        // if (statusMap['ipfs.IpfsService'] !== undefined) {
        //     healthImplementation.setStatus('ipfs.IpfsService', 'NOT_SERVING');
        // }
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
          server.forceShutdown() // Đảm bảo server tắt hẳn
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
