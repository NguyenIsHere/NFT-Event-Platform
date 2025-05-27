// src/clients/eventServiceClient.js (trong 05-ticket-service)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const EVENT_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'event.proto') // Sử dụng event.proto

// Kiểm tra biến môi trường
if (!process.env.EVENT_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for TicketService's EventClient: EVENT_SERVICE_ADDRESS is not defined in .env. Calls to Event service will likely use default 'localhost' and may fail in Docker."
  )
}
const EVENT_SERVICE_ADDRESS =
  process.env.EVENT_SERVICE_ADDRESS || 'localhost:50054' // Port của event-service

console.log(
  `TicketService: Event client attempting to connect to ${EVENT_SERVICE_ADDRESS} using proto: ${EVENT_PROTO_PATH}`
)

const eventPackageDefinition = protoLoader.loadSync(EVENT_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR] // Cho phép import google/api/annotations.proto
})

const eventProto = grpc.loadPackageDefinition(eventPackageDefinition).event // package 'event'

const eventServiceClient = new eventProto.EventService( // Sử dụng EventService từ event.proto
  EVENT_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

module.exports = eventServiceClient
