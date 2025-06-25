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
      this.client.GetEvent({ event_id: eventId }, (error, response) => {
        // ← SỬA: đổi id thành event_id
        if (error) {
          console.error(
            'ChatbotService EventClient: Error getting event:',
            error
          )
          resolve(null)
        } else {
          resolve(response.event)
        }
      })
    })
  }

  async getAllEvents () {
    return new Promise((resolve, reject) => {
      this.client.ListEvents({}, (error, response) => {
        // ← SỬA: đổi từ GetAllEvents thành ListEvents
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
      // Event service không có SearchEvents method, sử dụng ListEvents với filter
      this.client.ListEvents({}, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error searching events:',
            error
          )
          resolve([])
        } else {
          // Filter events locally based on query
          const allEvents = response.events || []
          const filteredEvents = allEvents.filter(
            event =>
              event.name?.toLowerCase().includes(query.toLowerCase()) ||
              event.description?.toLowerCase().includes(query.toLowerCase()) ||
              event.location?.toLowerCase().includes(query.toLowerCase())
          )
          resolve(filteredEvents)
        }
      })
    })
  }

  async getEventsByArtist (artist) {
    return new Promise((resolve, reject) => {
      // Event service không có GetEventsByArtist method, sử dụng ListEvents với filter
      this.client.ListEvents({}, (error, response) => {
        if (error) {
          console.error(
            'ChatbotService EventClient: Error getting events by artist:',
            error
          )
          resolve([])
        } else {
          // Filter events locally based on artist - nhưng Event proto không có artist field
          // Có thể filter theo organizer_id hoặc description
          const allEvents = response.events || []
          const filteredEvents = allEvents.filter(event =>
            event.description?.toLowerCase().includes(artist.toLowerCase())
          )
          resolve(filteredEvents)
        }
      })
    })
  }
}

module.exports = new EventClient()
