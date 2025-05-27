// 05-ticket-service/src/handlers/ticketTypeServiceHandlers.js (KHUNG SƯỜN CHI TIẾT HƠN)
const { TicketType } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const eventServiceClient = require('../clients/eventServiceClient') // Import eventServiceClient

function ticketTypeToProto (ttDoc) {
  /* ... (như đã cung cấp ở Canvas ticket_service_files_v1) ... */
  if (!ttDoc) return null
  const ttData = ttDoc.toJSON ? ttDoc.toJSON() : { ...ttDoc }
  return {
    id: ttData.id || ttDoc._id?.toString(),
    event_id: ttData.eventId || '',
    blockchain_event_id: ttData.blockchainEventId || '', // Đã là string
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
  const { event_id, blockchain_event_id, name, total_quantity, price_wei } =
    call.request
  console.log(
    `TicketService: CreateTicketType for event_id: ${event_id}, name: ${name}`
  )
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id format.'
      })
    }
    // 1. Kiểm tra Event có tồn tại không (qua event-service)
    try {
      await new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id },
          { deadline: new Date(Date.now() + 5000) },
          (err, response) => {
            if (err) return reject(err)
            if (!response || !response.event)
              return reject(new Error('Event not found via EventService.'))
            // So sánh blockchain_event_id từ request với cái của Event nếu cần
            if (response.event.blockchain_event_id !== blockchain_event_id) {
              return reject(
                new Error(
                  `BlockchainEventId mismatch: provided ${blockchain_event_id}, event has ${response.event.blockchain_event_id}`
                )
              )
            }
            resolve(response)
          }
        )
      })
    } catch (eventServiceError) {
      console.error(
        'TicketService: Error validating event via EventService:',
        eventServiceError.details || eventServiceError.message
      )
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Event validation failed: ${
          eventServiceError.details || eventServiceError.message
        }`
      })
    }

    const newTicketType = new TicketType({
      eventId: event_id,
      blockchainEventId: blockchain_event_id.toString(), // Đảm bảo là string
      name,
      totalQuantity: total_quantity,
      availableQuantity: total_quantity,
      priceWei: price_wei.toString() // Đảm bảo là string
    })
    const savedTicketType = await newTicketType.save()
    callback(null, ticketTypeToProto(savedTicketType))
  } catch (error) {
    console.error('TicketService: CreateTicketType RPC error:', error)
    if (
      error.code === 11000 ||
      (error.message && error.message.includes('duplicate key'))
    ) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message:
          'Ticket type name for this event already exists or other unique constraint violated.'
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

module.exports = { CreateTicketType, GetTicketType, ListTicketTypesByEvent }
