// src/handlers/eventServiceHandlers.js
const { Event, EVENT_STATUS_ENUM } = require('../models/Event') // Import Event và Enum
const grpc = require('@grpc/grpc-js')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
const mongoose = require('mongoose')
const {
  ticketServiceClient,
  ticketTypeServiceClient
} = require('../clients/ticketServiceClient')
const { extractUserIdFromMetadata } = require('../utils/jwtUtils')

// Helper chuyển đổi Mongoose document sang gRPC message
function eventToGrpcEvent (eventDoc) {
  if (!eventDoc) return null
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
          id: s.id,
          contract_session_id: s.contractSessionId || '',
          name: s.name,
          start_time: s.startTime,
          end_time: s.endTime
        }))
      : [],
    seat_map_enabled: eventJson.seatMapEnabled,
    status: eventJson.status || EVENT_STATUS_ENUM[0], // DRAFT
    is_active: eventJson.isActive,
    created_at: eventDoc.createdAt ? eventDoc.createdAt.toISOString() : '',
    updated_at: eventDoc.updatedAt ? eventDoc.updatedAt.toISOString() : '',
    blockchain_event_id: eventJson.blockchainEventId || ''
  }
}

async function CreateEvent (call, callback) {
  console.log('🔍 EventService: CreateEvent called')

  // ✅ LOG REQUEST DETAILS
  console.log('🔍 Request details:', {
    request: call.request,
    requestType: typeof call.request,
    requestKeys: call.request ? Object.keys(call.request) : 'No request object'
  })

  const {
    name,
    description,
    location,
    banner_file_content_base64,
    banner_original_file_name,
    sessions,
    seat_map_enabled
  } = call.request || {}

  // ✅ DETAILED FIELD LOGGING
  console.log('🔍 Extracted fields:', {
    name: `"${name}" (type: ${typeof name}, length: ${name?.length})`,
    description: `"${description?.substring(
      0,
      50
    )}..." (type: ${typeof description}, length: ${description?.length})`,
    location: `"${location}" (type: ${typeof location}, length: ${
      location?.length
    })`,
    sessions: `${sessions?.length} sessions (type: ${typeof sessions})`,
    seat_map_enabled: `${seat_map_enabled} (type: ${typeof seat_map_enabled})`,
    banner_file_content_base64: banner_file_content_base64
      ? `${banner_file_content_base64.length} chars`
      : 'None',
    banner_original_file_name: `"${banner_original_file_name}"`
  })

  // ✅ EXTRACT USER ID FROM JWT
  const organizerId = extractUserIdFromMetadata(call.metadata)

  console.log(
    `🔍 EventService: CreateEvent called for name: "${name}" by organizer: ${
      organizerId || 'UNKNOWN'
    }`
  )

  try {
    // ✅ VALIDATE ORGANIZER ID
    if (!organizerId) {
      console.error('🔥 EventService: No organizer_id found in JWT token')
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message:
          'Unable to identify user from JWT token. Please ensure you are properly authenticated.'
      })
    }

    // ✅ VALIDATE REQUIRED FIELDS WITH DETAILED ERRORS
    if (!name || typeof name !== 'string' || !name.trim()) {
      console.error('🔥 EventService: Invalid name:', {
        name,
        type: typeof name,
        trimmed: name?.trim()
      })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Event name is required and must be a non-empty string.'
      })
    }

    if (
      !description ||
      typeof description !== 'string' ||
      !description.trim()
    ) {
      console.error('🔥 EventService: Invalid description:', {
        description,
        type: typeof description,
        trimmed: description?.trim()
      })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Event description is required and must be a non-empty string.'
      })
    }

    if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
      console.error('🔥 EventService: Invalid sessions:', {
        sessions,
        type: typeof sessions,
        length: sessions?.length
      })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'At least one session is required.'
      })
    }

    console.log(
      '✅ EventService: All validations passed, proceeding with event creation...'
    )

    // ✅ PROCESS BANNER UPLOAD
    let bannerUrlCid = ''
    if (banner_file_content_base64 && banner_original_file_name) {
      console.log(
        `🔍 EventService: Uploading banner "${banner_original_file_name}" to IPFS...`
      )

      try {
        const fileContentBuffer = Buffer.from(
          banner_file_content_base64,
          'base64'
        )
        console.log(
          `🔍 EventService: Banner buffer size: ${fileContentBuffer.length} bytes`
        )

        const ipfsResponse = await new Promise((resolve, reject) => {
          ipfsServiceClient.PinFileToIPFS(
            {
              file_content: fileContentBuffer,
              original_file_name: banner_original_file_name,
              options: { pin_name: `event_banner_${name}_${Date.now()}` }
            },
            { deadline: new Date(Date.now() + 10000) },
            (err, response) => {
              if (err) {
                console.error(
                  '🔥 EventService: Error calling PinFileToIPFS:',
                  err.details || err.message
                )
                return reject(err)
              }
              resolve(response)
            }
          )
        })

        bannerUrlCid = ipfsResponse.ipfs_hash
        console.log(
          `✅ EventService: Banner uploaded to IPFS, CID: ${bannerUrlCid}`
        )
      } catch (ipfsError) {
        console.error('🔥 EventService: IPFS upload failed:', ipfsError)
        // Continue without banner rather than failing completely
        console.log(
          '⚠️ EventService: Continuing without banner due to upload failure'
        )
      }
    }

    // ✅ PROCESS SESSIONS
    const mongooseSessions = sessions.map((s_in, index) => {
      // ✅ FIX: Tạo contract session ID duy nhất
      const contractSessionId = `${Date.now()}${index
        .toString()
        .padStart(3, '0')}`

      console.log(`🔍 Creating session ${index + 1}:`, {
        name: s_in.name,
        contractSessionId,
        start_time: s_in.start_time,
        end_time: s_in.end_time
      })

      return {
        contractSessionId: contractSessionId, // ✅ FIX: Consistent field name
        name: s_in.name?.trim() || `${name.trim()} - Phiên ${index + 1}`,
        startTime: s_in.start_time,
        endTime: s_in.end_time
      }
    })

    console.log('🔍 EventService: Processed sessions:', mongooseSessions)

    // ✅ CREATE EVENT
    const newEvent = new Event({
      organizerId: organizerId,
      name: name.trim(),
      description: description.trim(),
      location: location?.trim() || '',
      bannerUrlCid,
      sessions: mongooseSessions,
      seatMapEnabled: Boolean(seat_map_enabled),
      status: EVENT_STATUS_ENUM[0], // DRAFT
      isActive: false
    })

    console.log('🔍 EventService: About to save event:', {
      organizerId: newEvent.organizerId,
      name: newEvent.name,
      description: newEvent.description?.substring(0, 50) + '...',
      sessionsCount: newEvent.sessions?.length,
      status: newEvent.status
    })

    const savedEvent = await newEvent.save()
    console.log(
      `✅ EventService: Event DRAFT "${name}" created with DB ID: ${savedEvent.id} for organizer: ${organizerId}`
    )

    // ✅ RETURN SUCCESS RESPONSE
    const response = { event: eventToGrpcEvent(savedEvent) }
    console.log('✅ EventService: Returning response:', response)

    callback(null, response)
  } catch (error) {
    console.error('🔥 EventService: CreateEvent RPC error:', error)

    // ✅ BETTER ERROR HANDLING
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(
        err => err.message
      )
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Validation error: ${validationErrors.join(', ')}`
      })
    }

    if (error.code === 11000) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'Event with this information already exists.'
      })
    }

    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to create event draft.'
    })
  }
}

async function PublishEvent (call, callback) {
  const { event_id, desired_blockchain_event_id } = call.request

  console.log(
    `EventService: PublishEvent called for DB event_id: ${event_id} with desired blockchain_id: ${desired_blockchain_event_id}`
  )

  let eventToPublish
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event ID format.'
      })
    }

    // ✅ FIX: Validate desired_blockchain_event_id
    if (
      !desired_blockchain_event_id ||
      desired_blockchain_event_id.trim() === ''
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'desired_blockchain_event_id is required and cannot be empty.'
      })
    }

    eventToPublish = await Event.findById(event_id)
    if (!eventToPublish) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Event draft not found to publish.'
      })
    }

    if (
      eventToPublish.status !== EVENT_STATUS_ENUM[0] &&
      eventToPublish.status !== EVENT_STATUS_ENUM[5]
    ) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Event cannot be published from status: ${eventToPublish.status}`
      })
    }

    console.log(
      `EventService: Attempting to register event ${eventToPublish.id} on blockchain with ID: ${desired_blockchain_event_id}`
    )

    eventToPublish.status = EVENT_STATUS_ENUM[1] // PENDING_PUBLISH
    await eventToPublish.save()

    // ✅ FIX: Call RegisterEventOnBlockchain with proper data
    const bcResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.RegisterEventOnBlockchain(
        {
          system_event_id_for_ref: event_id,
          blockchain_event_id: desired_blockchain_event_id,
          event_name: eventToPublish.name
        },
        { deadline: new Date(Date.now() + 30000) },
        (err, res) => {
          if (err) {
            console.error('❌ Blockchain RegisterEvent error:', err)
            reject(
              new Error(err.details || err.message || 'Blockchain call failed')
            )
          } else {
            console.log('✅ Blockchain RegisterEvent success:', res)
            resolve(res)
          }
        }
      )
    })

    if (bcResponse && bcResponse.success) {
      // ✅ FIX: Update event with blockchain data
      eventToPublish.blockchainEventId =
        bcResponse.actual_blockchain_event_id || desired_blockchain_event_id
      eventToPublish.status = EVENT_STATUS_ENUM[2] // ACTIVE
      eventToPublish.isActive = true
      await eventToPublish.save()

      console.log(
        `✅ EventService: Event ${eventToPublish.id} PUBLISHED. Blockchain ID: ${eventToPublish.blockchainEventId}, Tx: ${bcResponse.transaction_hash}`
      )

      callback(null, { event: eventToGrpcEvent(eventToPublish) })
    } else {
      throw new Error(
        'Blockchain registration failed: ' +
          (bcResponse?.message || 'Unknown error')
      )
    }
  } catch (error) {
    console.error(
      'EventService: PublishEvent RPC error:',
      error.details || error.message || error
    )

    if (eventToPublish) {
      eventToPublish.status = EVENT_STATUS_ENUM[5] // FAILED_PUBLISH
      await eventToPublish.save()
    }

    callback({
      code: grpc.status.INTERNAL,
      message: error.details || error.message || 'Failed to publish event.'
    })
  }
}

// GetEvent và ListEvents giữ nguyên logic cơ bản, nhưng ListEvents có thể cần filter theo status
async function GetEvent (call, callback) {
  /* ... như trước ... */
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
  const { organizer_id, status, page_size = 10, page_token } = call.request
  console.log(
    `EventService: ListEvents called, organizer_id: ${organizer_id}, status: ${status}, page_size: ${page_size}`
  )
  try {
    const query = {}
    if (organizer_id) {
      query.organizerId = organizer_id
    }
    if (status && EVENT_STATUS_ENUM.includes(status.toUpperCase())) {
      // Lọc theo status nếu có và hợp lệ
      query.status = status.toUpperCase()
      console.log(`EventService: Filtering by status: ${status.toUpperCase()}`)
    } else if (status) {
      console.warn(
        `EventService: Invalid status filter provided: ${status}. Ignoring status filter.`
      )
    }

    let skip = 0
    if (page_token && !isNaN(parseInt(page_token))) {
      skip = parseInt(page_token)
    }

    const events = await Event.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(page_size)
    const totalEvents = await Event.countDocuments(query)

    // FIX: Remove .event because eventToGrpcEvent already returns the event object
    const grpcEvents = events.map(eventDoc => eventToGrpcEvent(eventDoc))
    const next_page_token_value =
      skip + grpcEvents.length < totalEvents
        ? (skip + page_size).toString()
        : ''

    console.log(`EventService: Returning ${grpcEvents.length} events`)
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

module.exports = { CreateEvent, GetEvent, ListEvents, PublishEvent } // Thêm PublishEvent
