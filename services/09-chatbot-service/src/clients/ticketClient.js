const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const TICKET_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'ticket.proto')

// Kiểm tra biến môi trường
if (!process.env.TICKET_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for ChatbotService's TicketClient: TICKET_SERVICE_ADDRESS is not defined in .env. Calls to Ticket service will likely use default 'localhost' and may fail in Docker."
  )
}
const TICKET_SERVICE_ADDRESS =
  process.env.TICKET_SERVICE_ADDRESS || 'localhost:50055'

console.log(
  `ChatbotService: Ticket client attempting to connect to ${TICKET_SERVICE_ADDRESS} using proto: ${TICKET_PROTO_PATH}`
)

const packageDefinition = protoLoader.loadSync(TICKET_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})

const ticketProto = grpc.loadPackageDefinition(packageDefinition).ticket

class TicketClient {
  constructor () {
    this.client = new ticketProto.TicketService(
      TICKET_SERVICE_ADDRESS,
      grpc.credentials.createInsecure()
    )
  }

  async getTicketById (ticketId) {
    return new Promise((resolve, reject) => {
      this.client.GetTicket({ ticket_id: ticketId }, (error, response) => {
        // ← SỬA: đổi id thành ticket_id
        if (error) {
          console.error(
            'ChatbotService TicketClient: Error getting ticket:',
            error
          )
          resolve(null)
        } else {
          resolve(response.ticket)
        }
      })
    })
  }

  async getAllTickets () {
    return new Promise((resolve, reject) => {
      this.client.ListAllTickets({}, (error, response) => {
        // ← SỬA: đổi từ GetAllTickets thành ListAllTickets
        if (error) {
          console.error(
            'ChatbotService TicketClient: Error getting all tickets:',
            error
          )
          reject(error)
        } else {
          resolve(response.tickets || [])
        }
      })
    })
  }

  async getTicketsByEventId (eventId) {
    return new Promise((resolve, reject) => {
      this.client.ListTicketsByEvent(
        // ← SỬA: đổi từ GetTicketsByEvent thành ListTicketsByEvent
        { event_id: eventId },
        (error, response) => {
          if (error) {
            console.error(
              'ChatbotService TicketClient: Error getting tickets by event:',
              error
            )
            resolve([])
          } else {
            resolve(response.tickets || [])
          }
        }
      )
    })
  }

  async getTicketsByUserId (userId) {
    return new Promise((resolve, reject) => {
      this.client.ListTicketsByOwner(
        { owner_address: userId },
        (error, response) => {
          // ← SỬA: đổi method và field
          if (error) {
            console.error(
              'ChatbotService TicketClient: Error getting tickets by user:',
              error
            )
            resolve([])
          } else {
            resolve(response.tickets || [])
          }
        }
      )
    })
  }
}

module.exports = new TicketClient()
