// 04-event-service/src/handlers/eventServiceHandlers.js (KHUNG SƯỜN)
const Event = require('../models/Event') // Giả sử EventModel.js đổi tên thành Event.js
const grpc = require('@grpc/grpc-js')
const ipfsServiceClient = require('../clients/ipfsServiceClient') // Client gọi ipfs-service
const blockchainServiceClient = require('../clients/blockchainServiceClient') // Client gọi blockchain-service
const mongoose = require('mongoose')

// Helper để chuyển đổi Mongoose document sang gRPC message
function eventToEventResponse (eventDoc) {
  if (!eventDoc) return null
  const eventData = eventDoc.toJSON() // Sử dụng toJSON đã định nghĩa trong schema
  return {
    event: {
      ...eventData,
      // Đảm bảo các trường sessions và timestamp được định dạng đúng nếu cần
      sessions: eventData.sessions
        ? eventData.sessions.map(s => ({
            id: s.id || s._id?.toString(), // Lấy id hoặc _id
            name: s.name,
            start_time: s.startTime, // Giả sử model dùng startTime
            end_time: s.endTime // Giả sử model dùng endTime
          }))
        : [],
      created_at: eventDoc.createdAt ? eventDoc.createdAt.toISOString() : '',
      updated_at: eventDoc.updatedAt ? eventDoc.updatedAt.toISOString() : ''
      // blockchain_event_id đã là string trong model
    }
  }
}

async function CreateEvent (call, callback) {
  const {
    organizer_id,
    name,
    description,
    location,
    banner_file_content_base64, // Nội dung file banner đã mã hóa base64
    banner_original_file_name, // Tên file banner gốc
    sessions, // Đây là repeated SessionInput từ proto
    seat_map_enabled,
    is_active,
    initial_blockchain_event_id, // Các trường để đăng ký blockchain nếu có
    initial_price_wei,
    initial_total_supply
  } = call.request

  console.log(`CreateEvent called for: ${name} by organizer ${organizer_id}`)

  try {
    let bannerUrlCid = ''
    if (banner_file_content_base64 && banner_original_file_name) {
      // 1. Upload banner lên IPFS qua ipfs-service
      const fileContentBuffer = Buffer.from(
        banner_file_content_base64,
        'base64'
      )
      const ipfsResponse = await new Promise((resolve, reject) => {
        ipfsServiceClient.PinFileToIPFS(
          {
            file_content: fileContentBuffer,
            original_file_name: banner_original_file_name,
            options: { pin_name: `event_banner_${name}` } // Tùy chọn
          },
          (err, response) => {
            if (err) return reject(err)
            resolve(response)
          }
        )
      })
      bannerUrlCid = ipfsResponse.ipfs_hash
      console.log(`Banner uploaded to IPFS, CID: ${bannerUrlCid}`)
    }

    // Chuyển đổi SessionInput từ proto sang định dạng cho Mongoose schema
    const mongooseSessions = sessions.map(s_in => ({
      name: s_in.name,
      startTime: s_in.start_time, // Đảm bảo kiểu dữ liệu khớp với schema (Number)
      endTime: s_in.end_time // Đảm bảo kiểu dữ liệu khớp với schema (Number)
      // _id sẽ tự tạo nếu sessionSchema có _id: true
    }))

    const newEvent = new Event({
      organizerId: organizer_id,
      name,
      description,
      location,
      bannerUrlCid: bannerUrlCid,
      sessions: mongooseSessions,
      seatMapEnabled: seat_map_enabled,
      isActive: is_active
      // blockchainEventId sẽ được cập nhật sau nếu đăng ký blockchain thành công
    })

    const savedEvent = await newEvent.save()
    console.log(`Event created with DB ID: ${savedEvent.id}`)

    // 2. (Tùy chọn) Đăng ký Event lên Blockchain ngay nếu có thông tin
    let blockchainEventIdFromChain = savedEvent.blockchainEventId // Lấy từ DB nếu đã có

    if (
      initial_blockchain_event_id &&
      initial_price_wei &&
      initial_total_supply
    ) {
      console.log(
        `Registering event ${savedEvent.id} on blockchain with proposed ID ${initial_blockchain_event_id}`
      )
      try {
        const bcResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.RegisterEventOnBlockchain(
            {
              system_event_id_for_ref: savedEvent.id.toString(),
              blockchain_event_id: initial_blockchain_event_id, // string
              price_wei: initial_price_wei, // string
              total_supply: initial_total_supply // string
            },
            (err, response) => {
              if (err) return reject(err)
              resolve(response)
            }
          )
        })

        if (bcResponse && bcResponse.success) {
          blockchainEventIdFromChain = bcResponse.actual_blockchain_event_id
          // Cập nhật lại event trong DB với blockchain_event_id thực tế
          savedEvent.blockchainEventId = blockchainEventIdFromChain
          await savedEvent.save()
          console.log(
            `Event ${savedEvent.id} registered on blockchain, chain_event_id: ${blockchainEventIdFromChain}, tx: ${bcResponse.transaction_hash}`
          )
        } else {
          console.warn(
            `Failed to register event ${savedEvent.id} on blockchain:`,
            bcResponse?.message || 'Unknown error from blockchain service'
          )
          // Quyết định xem có nên rollback việc tạo event trong DB không, hoặc đánh dấu là chưa lên chain
        }
      } catch (bcError) {
        console.error(
          `Error calling BlockchainService for event ${savedEvent.id}:`,
          bcError.message
        )
        // Xử lý lỗi khi gọi blockchain service
      }
    }

    // Phải tạo EventResponse đúng cấu trúc proto
    callback(null, eventToEventResponse(savedEvent))
  } catch (error) {
    console.error('CreateEvent RPC error:', error)
    if (error.name === 'ValidationError') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: Object.values(error.errors)
          .map(e => e.message)
          .join(', ')
      })
    }
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to create event.'
    })
  }
}

async function GetEvent (call, callback) {
  const { event_id } = call.request
  console.log(`GetEvent called for ID: ${event_id}`)
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event ID format.'
      })
    }
    const event = await Event.findById(event_id)
    if (!event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Event not found.'
      })
    }
    callback(null, eventToEventResponse(event))
  } catch (error) {
    console.error('GetEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event.'
    })
  }
}

async function ListEvents (call, callback) {
  // Implement pagination and filtering logic here
  const { organizer_id, page_size = 10, page_token } = call.request
  console.log(
    `ListEvents called with organizer_id: ${organizer_id}, page_size: ${page_size}, page_token: ${page_token}`
  )

  try {
    const query = {}
    if (organizer_id) {
      query.organizerId = organizer_id
    }

    // Đơn giản hóa pagination cho ví dụ: bỏ qua page_token, dùng skip/limit
    // Trong thực tế, bạn nên dùng cursor-based pagination với page_token (ví dụ: _id > last_id_from_page_token)
    const skip = page_token ? parseInt(page_token, 10) : 0 // Đây là ví dụ đơn giản, không phải cursor thực sự

    const events = await Event.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(page_size)

    // Ví dụ next_page_token đơn giản (chỉ để minh họa)
    const next_page_token_value =
      events.length === page_size ? (skip + page_size).toString() : ''

    callback(null, {
      events: events.map(eventDoc => eventToEventResponse(eventDoc).event), // Lấy phần event từ EventResponse
      next_page_token: next_page_token_value
    })
  } catch (error) {
    console.error('ListEvents RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list events.'
    })
  }
}

module.exports = {
  CreateEvent,
  GetEvent,
  ListEvents
}
