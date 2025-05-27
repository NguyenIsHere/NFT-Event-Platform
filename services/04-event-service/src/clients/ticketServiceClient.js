// 04-event-service/src/clients/ticketServiceClient.js
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const TICKET_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ticket.proto')

const ticketPackageDefinition = protoLoader.loadSync(TICKET_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR] // Cho phép import google/api/annotations.proto
})
const ticketProto = grpc.loadPackageDefinition(ticketPackageDefinition).ticket // package 'ticket'

const TICKET_SERVICE_ADDRESS =
  process.env.TICKET_SERVICE_ADDRESS || 'localhost:50055' // Port của ticket-service

console.log(
  `EventService: Ticket client attempting to connect to ${TICKET_SERVICE_ADDRESS}`
)

const ticketServiceClient = new ticketProto.TicketService( // Sử dụng TicketService từ ticket.proto
  TICKET_SERVICE_ADDRESS,
  grpc.credentials.createInsecure()
)

// Client cho TicketTypeService
const ticketTypeServiceClient = new ticketProto.TicketTypeService(
  TICKET_SERVICE_ADDRESS, // Cùng địa chỉ vì chúng được host chung bởi 05-ticket-service
  grpc.credentials.createInsecure()
)

module.exports = {
  ticketServiceClient, // Dùng để gọi các RPC của TicketService
  ticketTypeServiceClient // Dùng để gọi các RPC của TicketTypeService
}
