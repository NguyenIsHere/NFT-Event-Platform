// 05-ticket-service/src/handlers/ticketTypeServiceHandlers.js (KHUNG SƯỜN CHI TIẾT HƠN)
const { TicketType } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const eventServiceClient = require('../clients/eventServiceClient') // Import eventServiceClient
const blockchainServiceClient = require('../clients/blockchainServiceClient')

// Helper to convert Mongoose doc to proto message
function ticketTypeToProto (ttDoc) {
  if (!ttDoc) return null
  const ttData = ttDoc.toJSON ? ttDoc.toJSON() : { ...ttDoc }
  return {
    id: ttData.id || ttDoc._id?.toString(),
    event_id: ttData.eventId || '',
    session_id: ttData.sessionId || '', // Thêm session_id
    contract_session_id: ttData.contractSessionId || '',
    blockchain_event_id: ttData.blockchainEventId || '',
    blockchain_ticket_type_id: ttData.blockchainTicketTypeId || '',
    name: ttData.name || '',
    total_quantity: ttData.totalQuantity || 0,
    available_quantity: ttData.availableQuantity || 0,
    price_wei: ttData.priceWei || '0',
    created_at: ttDoc.createdAt
      ? Math.floor(new Date(ttDoc.createdAt).getTime() / 1000)
      : 0,
    updated_at: ttDoc.updatedAt
      ? Math.floor(new Date(ttDoc.updatedAt).getTime() / 1000)
      : 0
  }
}

async function CreateTicketType (call, callback) {
  const { event_id, session_id, name, total_quantity, price_wei } = call.request

  console.log(`TicketTypeService: CreateTicketType called with:`, {
    event_id: `"${event_id}" (type: ${typeof event_id}, length: ${
      event_id?.length
    })`,
    session_id: `"${session_id}" (type: ${typeof session_id}, length: ${
      session_id?.length
    })`,
    name: `"${name}"`,
    total_quantity,
    price_wei: `"${price_wei}"`
  })

  try {
    // ✅ FIX: Better validation với specific error messages
    if (!event_id || typeof event_id !== 'string' || event_id.trim() === '') {
      console.error('❌ Invalid event_id:', { event_id, type: typeof event_id })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `event_id is required and must be a non-empty string. Received: "${event_id}"`
      })
    }

    if (
      !session_id ||
      typeof session_id !== 'string' ||
      session_id.trim() === ''
    ) {
      console.error('❌ Invalid session_id:', {
        session_id,
        type: typeof session_id
      })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `session_id is required and must be a non-empty string. Received: "${session_id}"`
      })
    }

    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      console.error('❌ Invalid event_id format:', event_id)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid event_id format: "${event_id}". Expected MongoDB ObjectId.`
      })
    }

    if (!mongoose.Types.ObjectId.isValid(session_id)) {
      console.error('❌ Invalid session_id format:', session_id)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid session_id format: "${session_id}". Expected MongoDB ObjectId.`
      })
    }

    // 1. Gọi event-service để lấy thông tin Event và Session
    console.log(
      `TicketTypeService: Fetching event details from EventService for event ID: ${event_id}`
    )

    const eventResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) {
            console.error('❌ EventService.GetEvent error:', err)
            reject(new Error(`Failed to fetch event: ${err.message}`))
          } else {
            console.log('✅ EventService.GetEvent success:', res)
            resolve(res)
          }
        }
      )
    })

    if (!eventResponse || !eventResponse.event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Event with ID ${event_id} not found.`
      })
    }

    const parentEvent = eventResponse.event
    console.log(`🔍 Parent event sessions:`, parentEvent.sessions)
    console.log(
      `🔍 Parent event blockchain_event_id:`,
      parentEvent.blockchain_event_id
    ) // ✅ ADD: Debug log

    // ✅ FIX: Validate that parent event has blockchain_event_id
    if (
      !parentEvent.blockchain_event_id ||
      parentEvent.blockchain_event_id === '0'
    ) {
      console.error(`❌ Parent event missing blockchain_event_id:`, {
        eventId: event_id,
        blockchainEventId: parentEvent.blockchain_event_id,
        status: parentEvent.status
      })
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Parent event "${event_id}" must be published to blockchain first. Current blockchain_event_id: "${
          parentEvent.blockchain_event_id || 'NONE'
        }"`
      })
    }

    console.log(
      `✅ Parent event has valid blockchain_event_id: "${parentEvent.blockchain_event_id}"`
    )

    // ✅ FIX: Tìm session với ID chính xác
    const targetSession = parentEvent.sessions.find(s => {
      console.log(
        `🔍 Comparing session: "${s.id}" === "${session_id}"`,
        s.id === session_id
      )
      return s.id === session_id
    })

    if (!targetSession) {
      console.error(
        `❌ Session not found in event. Looking for: "${session_id}"`
      )
      console.error(
        'Available sessions:',
        parentEvent.sessions.map(s => ({ id: s.id, name: s.name }))
      )
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Session with ID "${session_id}" not found in event "${event_id}".`
      })
    }

    // ✅ FIX: Validate contract_session_id
    if (!targetSession.contract_session_id) {
      console.error(`❌ Session missing contract_session_id:`, targetSession)
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Session "${session_id}" is missing contract_session_id. Event may not be properly published.`
      })
    }

    const contractSessionIdFromEvent = targetSession.contract_session_id
    console.log(
      `✅ Found session with contract_session_id: "${contractSessionIdFromEvent}"`
    )

    // ✅ FIX: Create TicketType với proper field mapping
    const newTicketType = new TicketType({
      eventId: event_id,
      sessionId: session_id,
      contractSessionId: contractSessionIdFromEvent,
      blockchainEventId: parentEvent.blockchain_event_id, // ✅ FIX: Inherit from parent
      blockchainTicketTypeId: '', // ✅ Will be set when published to blockchain
      name,
      totalQuantity: total_quantity,
      availableQuantity: total_quantity,
      priceWei: price_wei
    })

    const savedTicketType = await newTicketType.save()

    console.log(
      `✅ TicketType "${name}" created with ID ${savedTicketType.id} for session ${session_id}`
    )

    // ✅ FIX: Debug the blockchain fields before auto-publish check
    console.log(`🔍 TicketType blockchain fields:`, {
      id: savedTicketType.id,
      blockchainEventId: savedTicketType.blockchainEventId,
      blockchainTicketTypeId: savedTicketType.blockchainTicketTypeId,
      contractSessionId: savedTicketType.contractSessionId
    })

    // ✅ FIX: Auto-publish to blockchain if parent event is published
    if (
      savedTicketType.blockchainEventId &&
      savedTicketType.blockchainEventId !== '0'
    ) {
      console.log('🔄 Auto-publishing TicketType to blockchain...')

      try {
        const publishResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.RegisterTicketTypeOnBlockchain(
            {
              blockchain_event_id: savedTicketType.blockchainEventId,
              ticket_type_name: savedTicketType.name,
              price_wei: savedTicketType.priceWei,
              total_supply: savedTicketType.totalQuantity.toString()
            },
            (error, response) => {
              if (error) reject(error)
              else resolve(response)
            }
          )
        })

        if (publishResponse.success) {
          // Update with blockchain ticket type ID
          savedTicketType.blockchainTicketTypeId =
            publishResponse.blockchain_ticket_type_id
          await savedTicketType.save()

          console.log(
            `✅ TicketType auto-published with blockchain ID: ${publishResponse.blockchain_ticket_type_id}`
          )
        }
      } catch (publishError) {
        console.error('❌ Auto-publish failed:', publishError)
        // Don't fail the creation, just log the error
      }
    }

    callback(null, ticketTypeToProto(savedTicketType))
  } catch (error) {
    console.error('❌ TicketTypeService: CreateTicketType RPC error:', error)

    if (
      error.code === 11000 ||
      (error.message && error.message.includes('duplicate key'))
    ) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `TicketType "${name}" already exists for this event.`
      })
    }

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
      message: error.message || 'Failed to create ticket type.'
    })
  }
}

async function UpdateTicketType (call, callback) {
  const { ticket_type_id, blockchain_event_id /*, các trường khác nếu có */ } =
    call.request
  console.log(
    `TicketTypeService: UpdateTicketType called for ID: ${ticket_type_id} with blockchain_event_id: ${blockchain_event_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    const updateData = {}
    if (blockchain_event_id) {
      // Chỉ cập nhật nếu được cung cấp
      updateData.blockchainEventId = blockchain_event_id
    }
    // Thêm các trường khác vào updateData nếu message UpdateTicketTypeRequest có chúng
    // if (call.request.name && call.request.name.value) updateData.name = call.request.name.value;
    // if (call.request.total_quantity && call.request.total_quantity.value !== undefined) {
    //   updateData.totalQuantity = call.request.total_quantity.value;
    //   // Cân nhắc cập nhật availableQuantity tương ứng nếu totalQuantity thay đổi
    // }

    if (Object.keys(updateData).length === 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'No update fields provided.'
      })
    }

    const updatedTicketType = await TicketType.findByIdAndUpdate(
      ticket_type_id,
      { $set: updateData },
      { new: true } // Trả về document đã được cập nhật
    )

    if (!updatedTicketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found to update.'
      })
    }
    console.log(
      `TicketTypeService: TicketType ${updatedTicketType.id} updated. BlockchainEventId set to ${updatedTicketType.blockchainEventId}`
    )
    callback(null, ticketTypeToProto(updatedTicketType))
  } catch (error) {
    console.error('TicketTypeService: UpdateTicketType RPC error:', error)
    if (error.code === 11000) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message:
          'Update would cause a duplicate key violation (e.g., blockchainEventId if it has unique constraint with other fields).'
      })
    }
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to update ticket type.'
    })
  }
}

async function GetTicketType (call, callback) {
  const { ticket_type_id } = call.request
  console.log(`TicketService: GetTicketType for ID: ${ticket_type_id}`)
  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }
    callback(null, ticketTypeToProto(ticketType))
  } catch (error) {
    console.error('TicketService: GetTicketType RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to get ticket type.'
    })
  }
}

async function ListTicketTypesByEvent (call, callback) {
  const { event_id } = call.request
  console.log(`TicketService: ListTicketTypesByEvent for event_id: ${event_id}`)
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id format.'
      })
    }
    const ticketTypes = await TicketType.find({ eventId: event_id }).sort({
      createdAt: 1
    })
    callback(null, {
      ticket_types: ticketTypes.map(tt => ticketTypeToProto(tt))
    })
  } catch (error) {
    console.error('TicketService: ListTicketTypesByEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to list ticket types for event.'
    })
  }
}

async function ListTicketTypesBySession (call, callback) {
  const { event_id, session_id } = call.request
  console.log(
    `TicketTypeService: ListTicketTypesBySession for event_id: ${event_id}, session_id: ${session_id}`
  )
  try {
    if (
      !mongoose.Types.ObjectId.isValid(event_id) ||
      (session_id && !mongoose.Types.ObjectId.isValid(session_id))
    ) {
      // Giả sử session_id cũng là ObjectId nếu nó là _id của Mongoose
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id or session_id format.'
      })
    }
    const query = { eventId: event_id }
    if (session_id) {
      query.sessionId = session_id
    }
    const ticketTypes = await TicketType.find(query).sort({ createdAt: 1 })
    callback(null, {
      ticket_types: ticketTypes.map(tt => ticketTypeToProto(tt))
    })
  } catch (error) {
    console.error(
      'TicketTypeService: ListTicketTypesBySession RPC error:',
      error
    )
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to list ticket types for session.'
    })
  }
}

async function GetTicketTypeWithAvailability (call, callback) {
  const { ticket_type_id } = call.request
  console.log(
    `TicketService: GetTicketTypeWithAvailability for ID: ${ticket_type_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    // ✅ FIX: Implement the method properly
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    // ✅ FIX: Import Ticket model để tính toán real availability
    const { Ticket } = require('../models/Ticket')

    // Calculate real available quantity from actual tickets
    const soldTicketsCount = await Ticket.countDocuments({
      ticketTypeId: ticket_type_id,
      status: { $in: ['PAID', 'MINTING', 'MINTED'] }
    })

    const realAvailableQuantity = Math.max(
      0,
      ticketType.totalQuantity - soldTicketsCount
    )

    // Update available quantity if needed
    if (ticketType.availableQuantity !== realAvailableQuantity) {
      ticketType.availableQuantity = realAvailableQuantity
      await ticketType.save()
      console.log(
        `TicketType ${ticket_type_id} availability updated: ${realAvailableQuantity}`
      )
    }

    callback(null, ticketTypeToProto(ticketType))
  } catch (error) {
    console.error('TicketService: GetTicketTypeWithAvailability error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get ticket type with availability.'
    })
  }
}

async function PublishTicketType (call, callback) {
  const { ticket_type_id } = call.request
  console.log(
    `TicketTypeService: PublishTicketType called for ID: ${ticket_type_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    // Check if already published
    if (
      ticketType.blockchainTicketTypeId &&
      ticketType.blockchainTicketTypeId !== '0'
    ) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'TicketType is already published to blockchain.'
      })
    }

    // Check if parent event is published
    if (!ticketType.blockchainEventId || ticketType.blockchainEventId === '0') {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Parent event must be published to blockchain first.'
      })
    }

    // Call blockchain service to register ticket type
    const bcResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.RegisterTicketTypeOnBlockchain(
        {
          blockchain_event_id: ticketType.blockchainEventId,
          ticket_type_name: ticketType.name,
          price_wei: ticketType.priceWei,
          total_supply: ticketType.totalQuantity.toString()
        },
        { deadline: new Date(Date.now() + 60000) },
        (err, response) => {
          if (err) reject(err)
          else resolve(response)
        }
      )
    })

    if (bcResponse && bcResponse.success) {
      // Update ticket type with blockchain ID
      ticketType.blockchainTicketTypeId = bcResponse.blockchain_ticket_type_id
      const updatedTicketType = await ticketType.save()

      console.log(
        `TicketTypeService: TicketType ${updatedTicketType.id} published. Blockchain TicketType ID: ${updatedTicketType.blockchainTicketTypeId}`
      )

      callback(null, ticketTypeToProto(updatedTicketType))
    } else {
      throw new Error(
        `Failed to register ticket type on blockchain: ${
          bcResponse?.message || 'Blockchain service error'
        }`
      )
    }
  } catch (error) {
    console.error('TicketTypeService: PublishTicketType error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to publish ticket type.'
    })
  }
}

module.exports = {
  CreateTicketType,
  UpdateTicketType,
  GetTicketType,
  GetTicketTypeWithAvailability,
  ListTicketTypesByEvent,
  ListTicketTypesBySession,
  PublishTicketType // ✅ NEW
}
