// 04-event-service/src/handlers/eventServiceHandlers.js
const Event = require('../models/Event')
const grpc = require('@grpc/grpc-js')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
const mongoose = require('mongoose')

// Helper chuyển đổi Mongoose document sang gRPC message (đảm bảo khớp với Event message trong event.proto)
function eventToGrpcEvent (eventDoc) {
  if (!eventDoc) return null
  // Sử dụng toJSON() đã được tùy chỉnh trong schema để có 'id' và bỏ '_id', '__v'
  const eventJson = eventDoc.toJSON()

  return {
    id: eventJson.id,
    organizer_id: eventJson.organizerId,
    name: eventJson.name,
    description: eventJson.description || '',
    location: eventJson.location || '',
    banner_url_cid: eventJson.bannerUrlCid || '',
    sessions: eventJson.sessions
      ? eventJson.sessions.map(s => ({
          id: s.id, // session đã có virtual 'id'
          name: s.name,
          start_time: s.startTime, // Đảm bảo là int64 (Number trong JS)
          end_time: s.endTime // Đảm bảo là int64 (Number trong JS)
        }))
      : [],
    seat_map_enabled: eventJson.seatMapEnabled,
    is_active: eventJson.isActive,
    created_at: eventDoc.createdAt ? eventDoc.createdAt.toISOString() : '', // Chuyển Date sang ISO string
    updated_at: eventDoc.updatedAt ? eventDoc.updatedAt.toISOString() : '', // Chuyển Date sang ISO string
    blockchain_event_id: eventJson.blockchainEventId || '' // Đã là string
  }
}

async function CreateEvent (call, callback) {
  const {
    organizer_id,
    name,
    description,
    location,
    banner_file_content_base64,
    banner_original_file_name,
    sessions,
    seat_map_enabled,
    is_active,
    initial_blockchain_event_id,
    initial_price_wei,
    initial_total_supply
  } = call.request

  console.log(
    `EventService: CreateEvent called for name: "${name}" by organizer: ${organizer_id}`
  )

  try {
    let bannerUrlCid = ''
    if (banner_file_content_base64 && banner_original_file_name) {
      console.log(
        `EventService: Uploading banner "${banner_original_file_name}" to IPFS...`
      )
      const fileContentBuffer = Buffer.from(
        banner_file_content_base64,
        'base64'
      )

      const ipfsResponse = await new Promise((resolve, reject) => {
        ipfsServiceClient.PinFileToIPFS(
          {
            file_content: fileContentBuffer,
            original_file_name: banner_original_file_name,
            options: { pin_name: `event_banner_${name}_${Date.now()}` }
          },
          { deadline: new Date(Date.now() + 5000) }, // Timeout 5 giây
          (err, response) => {
            if (err) {
              console.error(
                'EventService: Error calling PinFileToIPFS -',
                err.details || err.message
              )
              return reject(err)
            }
            resolve(response)
          }
        )
      })
      bannerUrlCid = ipfsResponse.ipfs_hash
      console.log(`EventService: Banner uploaded to IPFS, CID: ${bannerUrlCid}`)
    }

    const mongooseSessions = sessions.map(s_in => ({
      name: s_in.name,
      startTime: Number(s_in.start_time), // Chuyển từ int64 (string/number) sang Number
      endTime: Number(s_in.end_time)
    }))

    const newEvent = new Event({
      organizerId: organizer_id,
      name,
      description,
      location,
      bannerUrlCid,
      sessions: mongooseSessions,
      seatMapEnabled: seat_map_enabled,
      isActive: is_active
      // blockchainEventId sẽ được cập nhật sau nếu đăng ký thành công
    })

    let savedEvent = await newEvent.save()
    console.log(
      `EventService: Event "${name}" created with DB ID: ${savedEvent.id}`
    )

    if (
      initial_blockchain_event_id &&
      initial_price_wei &&
      initial_total_supply
    ) {
      console.log(
        `EventService: Registering event ${savedEvent.id} on blockchain with proposed ID ${initial_blockchain_event_id}`
      )
      try {
        const bcResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.RegisterEventOnBlockchain(
            {
              system_event_id_for_ref: savedEvent.id.toString(),
              blockchain_event_id: initial_blockchain_event_id.toString(), // Đảm bảo là string
              price_wei: initial_price_wei.toString(),
              total_supply: initial_total_supply.toString()
            },
            { deadline: new Date(Date.now() + 15000) }, // Timeout 15 giây cho giao dịch blockchain
            (err, response) => {
              if (err) {
                console.error(
                  'EventService: Error calling RegisterEventOnBlockchain -',
                  err.details || err.message
                )
                return reject(err)
              }
              resolve(response)
            }
          )
        })

        if (bcResponse && bcResponse.success) {
          savedEvent.blockchainEventId = bcResponse.actual_blockchain_event_id
          savedEvent = await savedEvent.save() // Lưu lại với blockchainEventId
          console.log(
            `EventService: Event ${savedEvent.id} registered on blockchain, chain_event_id: ${savedEvent.blockchainEventId}, tx: ${bcResponse.transaction_hash}`
          )
        } else {
          console.warn(
            `EventService: Failed to register event ${savedEvent.id} on blockchain:`,
            bcResponse?.message || 'Unknown error from blockchain service'
          )
        }
      } catch (bcError) {
        console.error(
          `EventService: Error calling BlockchainService for event ${savedEvent.id}:`,
          bcError.message
        )
      }
    }

    callback(null, { event: eventToGrpcEvent(savedEvent) })
  } catch (error) {
    console.error('EventService: CreateEvent RPC error:', error)
    if (error.name === 'ValidationError') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: Object.values(error.errors)
          .map(e => e.message)
          .join(', ')
      })
    }
    if (error.code === 11000) {
      // MongoDB duplicate key error
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'Event with this blockchainEventId already exists.'
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
  console.log(`EventService: GetEvent called for ID: ${event_id}`)
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
    callback(null, { event: eventToGrpcEvent(event) })
  } catch (error) {
    console.error('EventService: GetEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event.'
    })
  }
}

async function ListEvents (call, callback) {
  const { organizer_id, page_size = 10, page_token } = call.request // page_token chưa dùng ở đây
  console.log(
    `EventService: ListEvents called, organizer_id: ${organizer_id}, page_size: ${page_size}`
  )
  try {
    const query = {}
    if (organizer_id) {
      query.organizerId = organizer_id
    }
    // Logic pagination đơn giản (cần cải thiện cho production)
    let skip = 0
    if (page_token && !isNaN(parseInt(page_token))) {
      skip = parseInt(page_token) // page_token đang là số trang bỏ qua (ví dụ)
    }

    const events = await Event.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(page_size)
    const totalEvents = await Event.countDocuments(query) // Để tính toán next_page_token

    const grpcEvents = events.map(eventDoc => eventToGrpcEvent(eventDoc).event)

    // next_page_token đơn giản, nếu còn item thì là skip + page_size
    const next_page_token_value =
      skip + grpcEvents.length < totalEvents
        ? (skip + page_size).toString()
        : ''

    callback(null, {
      events: grpcEvents,
      next_page_token: next_page_token_value
    })
  } catch (error) {
    console.error('EventService: ListEvents RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list events.'
    })
  }
}

module.exports = { CreateEvent, GetEvent, ListEvents }
