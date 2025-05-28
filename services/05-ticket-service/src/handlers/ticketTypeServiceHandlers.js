// 05-ticket-service/src/handlers/ticketTypeServiceHandlers.js (KHUNG SƯỜN CHI TIẾT HƠN)
const { TicketType } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const eventServiceClient = require('../clients/eventServiceClient') // Import eventServiceClient

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
  console.log(
    `TicketTypeService: CreateTicketType called for event_id: ${event_id}, session_id: ${session_id}, name: ${name}`
  )
  try {
    if (
      !mongoose.Types.ObjectId.isValid(event_id) ||
      !mongoose.Types.ObjectId.isValid(session_id)
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id or session_id format.'
      })
    }

    // 1. Gọi event-service để lấy thông tin Event và Session, bao gồm contract_session_id
    console.log(
      `TicketTypeService: Fetching event details from EventService for event ID: ${event_id}`
    )
    const eventResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id: event_id },
        { deadline: new Date(Date.now() + 5000) },
        (err, res) => {
          if (err) {
            console.error(
              'TicketTypeService: Error calling GetEvent from EventService -',
              err.details || err.message
            )
            return reject(err)
          }
          resolve(res)
        }
      )
    })

    if (!eventResponse || !eventResponse.event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Parent event with ID ${event_id} not found.`
      })
    }

    const parentEvent = eventResponse.event
    // Tìm session tương ứng trong event để lấy contract_session_id
    const targetSession = parentEvent.sessions.find(s => s.id === session_id) // s.id ở đây là MongoDB ObjectId của session
    if (!targetSession) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Session ${session_id} not found in event ${event_id}.`
      })
    }
    if (
      !targetSession.contract_session_id &&
      targetSession.contract_session_id !== '0'
    ) {
      // Cho phép contract_session_id là "0"
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `contract_session_id not found for session ${session_id} in event ${event_id}. Ensure event sessions have contract_session_id.`
      })
    }
    const contractSessionIdFromEvent = targetSession.contract_session_id
    console.log(
      `TicketTypeService: Found contract_session_id: ${contractSessionIdFromEvent} for session_id (Mongo): ${session_id}`
    )

    const newTicketType = new TicketType({
      eventId: event_id,
      sessionId: session_id, // Lưu session_id
      contractSessionId: contractSessionIdFromEvent, // Lưu ID số dùng cho contract
      // blockchainEventId: để trống, sẽ được cập nhật sau
      name,
      totalQuantity: total_quantity,
      availableQuantity: total_quantity, // Ban đầu
      priceWei: price_wei
    })
    const savedTicketType = await newTicketType.save()
    console.log(
      `TicketTypeService: TicketType "${name}" created with ID ${savedTicketType.id} for session ${session_id}`
    )
    callback(null, ticketTypeToProto(savedTicketType))
  } catch (error) {
    console.error('TicketTypeService: CreateTicketType RPC error:', error)
    if (
      error.code === 11000 ||
      (error.message && error.message.includes('duplicate key'))
    ) {
      // Giả sử bạn có unique index trên (eventId, sessionId, name)
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'Ticket type with this name already exists for this session.'
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

module.exports = {
  CreateTicketType,
  UpdateTicketType, // Thêm handler mới
  GetTicketType,
  ListTicketTypesByEvent,
  ListTicketTypesBySession // Thêm handler mới
}
