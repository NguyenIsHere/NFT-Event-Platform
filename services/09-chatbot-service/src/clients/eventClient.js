const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const path = require('path')

// Đường dẫn đến thư mục protos chung từ thư mục src/clients/
const PROTOS_ROOT_DIR = path.join(process.cwd(), 'protos')
const EVENT_PROTO_PATH = path.join(PROTOS_ROOT_DIR, 'event.proto')

// Kiểm tra biến môi trường
if (!process.env.EVENT_SERVICE_ADDRESS) {
  console.warn(
    "WARNING for ChatbotService's EventClient: EVENT_SERVICE_ADDRESS is not defined in .env. Calls to Event service will likely use default 'localhost' and may fail in Docker."
  )
}
const EVENT_SERVICE_ADDRESS =
  process.env.EVENT_SERVICE_ADDRESS || 'localhost:50054'

console.log(
  `ChatbotService: Event client attempting to connect to ${EVENT_SERVICE_ADDRESS} using proto: ${EVENT_PROTO_PATH}`
)

const packageDefinition = protoLoader.loadSync(EVENT_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT_DIR]
})

const eventProto = grpc.loadPackageDefinition(packageDefinition).event

class EventClient {
  constructor () {
    this.client = new eventProto.EventService(
      EVENT_SERVICE_ADDRESS,
      grpc.credentials.createInsecure()
    )
  }

  async getEventById (eventId) {
    return new Promise((resolve, reject) => {
      this.client.GetEvent({ id: eventId }, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error getting event:',
            error
          )
          resolve(null) // Return null instead of rejecting để không break flow
        } else {
          resolve(response.event)
        }
      })
    })
  }

  async getAllEvents () {
    return new Promise((resolve, reject) => {
      this.client.GetAllEvents({}, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error getting all events:',
            error
          )
          reject(error)
        } else {
          resolve(response.events || [])
        }
      })
    })
  }

  async searchEvents (query) {
    return new Promise((resolve, reject) => {
      this.client.SearchEvents({ query }, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error searching events:',
            error
          )
          resolve([]) // Return empty array instead of rejecting
        } else {
          resolve(response.events || [])
        }
      })
    })
  }

  async getEventsByArtist (artist) {
    return new Promise((resolve, reject) => {
      this.client.GetEventsByArtist({ artist }, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error getting events by artist:',
            error
          )
          resolve([])
        } else {
          resolve(response.events || [])
        }
      })
    })
  }
}

module.exports = new EventClient()
