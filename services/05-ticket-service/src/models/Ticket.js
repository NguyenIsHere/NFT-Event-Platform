// 05-ticket-service/src/models/Ticket.js
// (Bao gồm cả TicketType và Ticket schema như đã cung cấp trong Canvas ticket_service_mongoose_schemas)
const mongoose = require('mongoose')
const Schema = mongoose.Schema

// TicketType Schema
const ticketTypeSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    blockchainEventId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    totalQuantity: { type: Number, required: true },
    availableQuantity: { type: Number, required: true },
    priceWei: { type: String, required: true }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString()
        delete ret._id
        delete ret.__v
        return ret
      }
    }
  }
)
ticketTypeSchema.virtual('id').get(function () {
  return this._id.toHexString()
})
ticketTypeSchema.index({ eventId: 1, name: 1 }, { unique: true })
const TicketType = mongoose.model('TicketType', ticketTypeSchema)

// Ticket Schema
const TICKET_STATUS_ENUM = [
  'AVAILABLE',
  'SOLD',
  'USED',
  'PENDING_MINT',
  'MINTED',
  'CANCELLED'
]
const ticketSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    ticketTypeId: { type: String, required: true, index: true }, // ref: 'TicketType'
    tokenId: { type: String, unique: true, sparse: true, trim: true },
    ownerAddress: { type: String, trim: true, lowercase: true, index: true },
    sessionId: { type: String, required: false },
    status: { type: String, enum: TICKET_STATUS_ENUM, default: 'AVAILABLE' },
    tokenUriCid: { type: String, required: false },
    transactionHash: { type: String, required: false }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString()
        delete ret._id
        delete ret.__v
        return ret
      }
    }
  }
)
ticketSchema.virtual('id').get(function () {
  return this._id.toHexString()
})
ticketSchema.index({ tokenId: 1 }, { unique: true, sparse: true })

const Ticket = mongoose.model('Ticket', ticketSchema)

module.exports = { Ticket, TicketType, TICKET_STATUS_ENUM }
