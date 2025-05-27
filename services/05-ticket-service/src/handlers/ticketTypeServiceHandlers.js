// 05-ticket-service/src/handlers/ticketTypeServiceHandlers.js (KHUNG SƯỜN)
const { TicketType } = require('../models/Ticket') // Giả sử export chung từ Ticket.js (hoặc TicketType.js riêng)
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
// const eventServiceClient = require('../clients/eventServiceClient'); // Nếu cần kiểm tra Event tồn tại

// Helper để chuyển đổi TicketType model sang TicketType message của proto
function ticketTypeToProto (ttDoc) {
  if (!ttDoc) return null
  const ttData = ttDoc.toJSON()
  return {
    ...ttData,
    created_at: ttDoc.createdAt
      ? Math.floor(new Date(ttDoc.createdAt).getTime() / 1000)
      : 0,
    updated_at: ttDoc.updatedAt
      ? Math.floor(new Date(ttDoc.updatedAt).getTime() / 1000)
      : 0
    // blockchain_event_id đã là string
  }
}

async function CreateTicketType (call, callback) {
  const { event_id, blockchain_event_id, name, total_quantity, price_wei } =
    call.request
  console.log(
    `CreateTicketType called for event_id: ${event_id}, name: ${name}`
  )
  try {
    // (Tùy chọn) Kiểm tra xem event_id có hợp lệ không bằng cách gọi event-service
    // if (!mongoose.Types.ObjectId.isValid(event_id)) { ... }
    // const event = await eventServiceClient.GetEvent({ event_id }); if (!event) ...

    const newTicketType = new TicketType({
      eventId: event_id,
      blockchainEventId: blockchain_event_id, // Đảm bảo đây là string uint256
      name,
      totalQuantity: total_quantity,
      availableQuantity: total_quantity, // Ban đầu số lượng còn lại bằng tổng số
      priceWei: price_wei
    })
    const savedTicketType = await newTicketType.save()
    callback(null, ticketTypeToProto(savedTicketType))
  } catch (error) {
    console.error('CreateTicketType RPC error:', error)
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

// ... (Các handlers khác như GetTicketType, ListTicketTypesByEvent) ...
async function GetTicketType (call, callback) {
  const { ticket_type_id } = call.request
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
    // ...
  }
}

module.exports = {
  CreateTicketType,
  GetTicketType
  // ListTicketTypesByEvent,
}
