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
  const {
    organizer_id,
    name,
    description,
    location,
    banner_file_content_base64,
    banner_original_file_name,
    sessions,
    seat_map_enabled
    // is_active được bỏ, mặc định là DRAFT và is_active=false
  } = call.request

  console.log(
    `EventService: CreateEvent (DRAFT) called for name: "${name}" by organizer: ${organizer_id}`
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
          { deadline: new Date(Date.now() + 10000) }, // Timeout 10 giây
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
      startTime: Number(s_in.start_time),
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
      status: EVENT_STATUS_ENUM[0], // DRAFT
      isActive: false // Mặc định chưa active khi là DRAFT
      // blockchainEventId sẽ được điền khi PublishEvent
    })

    const savedEvent = await newEvent.save()
    console.log(
      `EventService: Event DRAFT "${name}" created with DB ID: ${savedEvent.id}`
    )

    callback(null, { event: eventToGrpcEvent(savedEvent) })
  } catch (error) {
    console.error('EventService: CreateEvent RPC error:', error)
    // ... (xử lý lỗi validation, duplicate key nếu cần cho các trường khác)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to create event draft.'
    })
  }
}

async function PublishEvent (call, callback) {
  const {
    event_id,
    desired_blockchain_event_id,
    default_price_wei_on_chain,
    total_supply_on_chain
  } = call.request

  console.log(
    `EventService: PublishEvent called for DB event_id: ${event_id} with desired blockchain_id: ${desired_blockchain_event_id}`
  )

  let eventToPublish // Khai báo ở phạm vi rộng hơn để dùng trong finally hoặc catch nếu cần
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event ID format.'
      })
    }
    eventToPublish = await Event.findById(event_id) // Gán giá trị cho biến đã khai báo
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
      // DRAFT or FAILED_PUBLISH
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Event cannot be published from status: ${eventToPublish.status}`
      })
    }
    if (
      eventToPublish.blockchainEventId &&
      eventToPublish.status === EVENT_STATUS_ENUM[2]
    ) {
      // ACTIVE
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'Event is already published and active on blockchain.'
      })
    }

    // Logic để xác định default_price_wei_on_chain và total_supply_on_chain
    // có thể dựa vào thông tin từ request hoặc tổng hợp từ các TicketType.
    // Hiện tại, chúng ta sử dụng giá trị từ request.
    // Bạn có thể thêm logic gọi ticketTypeServiceClient.ListTicketTypesByEvent ở đây nếu cần.

    console.log(
      `EventService: Attempting to register event ${eventToPublish.id} on blockchain...`
    )
    eventToPublish.status = EVENT_STATUS_ENUM[1] // PENDING_PUBLISH
    await eventToPublish.save()

    const bcResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.RegisterEventOnBlockchain(
        {
          system_event_id_for_ref: eventToPublish.id.toString(),
          blockchain_event_id: desired_blockchain_event_id.toString(),
          price_wei: default_price_wei_on_chain.toString(),
          total_supply: total_supply_on_chain.toString()
        },
        { deadline: new Date(Date.now() + 60000) }, // Timeout dài hơn cho blockchain (60s)
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    if (bcResponse && bcResponse.success) {
      eventToPublish.blockchainEventId = bcResponse.actual_blockchain_event_id
      eventToPublish.status = EVENT_STATUS_ENUM[2] // ACTIVE
      eventToPublish.isActive = true
      const publishedEvent = await eventToPublish.save()
      console.log(
        `EventService: Event ${publishedEvent.id} PUBLISHED. Blockchain ID: ${publishedEvent.blockchainEventId}, Tx: ${bcResponse.transaction_hash}`
      )

      // === BƯỚC MỚI: CẬP NHẬT TicketTypes ===
      console.log(
        `EventService: Updating TicketTypes for event ${publishedEvent.id} with blockchain_event_id ${publishedEvent.blockchainEventId}`
      )
      try {
        const listTicketTypesResponse = await new Promise((resolve, reject) => {
          ticketTypeServiceClient.ListTicketTypesByEvent(
            { event_id: publishedEvent.id.toString() },
            { deadline: new Date(Date.now() + 5000) },
            (err, response) => {
              if (err) return reject(err)
              resolve(response)
            }
          )
        })

        if (listTicketTypesResponse && listTicketTypesResponse.ticket_types) {
          const updatePromises = listTicketTypesResponse.ticket_types.map(
            tt => {
              console.log(
                `EventService: Calling UpdateTicketType for TicketType ID: ${tt.id} to set blockchain_event_id: ${publishedEvent.blockchainEventId}`
              )
              return new Promise((resolve, reject) => {
                ticketTypeServiceClient.UpdateTicketType(
                  {
                    ticket_type_id: tt.id,
                    blockchain_event_id: publishedEvent.blockchainEventId // Chỉ cập nhật trường này
                  },
                  { deadline: new Date(Date.now() + 5000) },
                  (err, updatedTt) => {
                    if (err) {
                      console.error(
                        `EventService: Failed to update TicketType ${tt.id}:`,
                        err.details || err.message
                      )
                      return reject(err) // Hoặc chỉ log lỗi và tiếp tục
                    }
                    console.log(
                      `EventService: TicketType ${updatedTt.id} updated with blockchain_event_id.`
                    )
                    resolve(updatedTt)
                  }
                )
              })
            }
          )
          await Promise.all(updatePromises) // Chờ tất cả các update hoàn thành
          console.log(
            `EventService: Finished updating ${listTicketTypesResponse.ticket_types.length} ticket types for event ${publishedEvent.id}.`
          )
        } else {
          console.log(
            `EventService: No ticket types found for event ${publishedEvent.id} to update.`
          )
        }
      } catch (ticketServiceError) {
        // Lỗi khi gọi TicketService, có thể log lại nhưng không nên làm PublishEvent thất bại hoàn toàn chỉ vì bước này
        console.error(
          `EventService: Error updating ticket types for event ${publishedEvent.id}:`,
          ticketServiceError.details || ticketServiceError.message
        )
        // Event vẫn được coi là publish thành công lên chain. Việc cập nhật TicketType có thể retry sau.
      }
      // === KẾT THÚC BƯỚC MỚI ===

      callback(null, { event: eventToGrpcEvent(publishedEvent) })
    } else {
      throw new Error(
        `Failed to register event on blockchain: ${
          bcResponse?.message || 'Blockchain service error'
        }`
      )
    }
  } catch (error) {
    console.error(
      'EventService: PublishEvent RPC error:',
      error.details || error.message || error
    )
    if (eventToPublish) {
      // Cố gắng cập nhật status về FAILED_PUBLISH nếu có thể
      try {
        eventToPublish.status = EVENT_STATUS_ENUM[5] // FAILED_PUBLISH
        await eventToPublish.save()
      } catch (updateError) {
        console.error(
          'EventService: Could not update event status to FAILED_PUBLISH:',
          updateError
        )
      }
    }

    let grpcErrorCode = grpc.status.INTERNAL
    if (error.code && Object.values(grpc.status).includes(error.code)) {
      grpcErrorCode = error.code
    }
    callback({
      code: grpcErrorCode,
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

    const grpcEvents = events.map(eventDoc => eventToGrpcEvent(eventDoc).event)
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

module.exports = { CreateEvent, GetEvent, ListEvents, PublishEvent } // Thêm PublishEvent
