// 05-ticket-service/src/models/Ticket.js
// (Bao gồm cả TicketType và Ticket schema như đã cung cấp trong Canvas ticket_service_mongoose_schemas)
const mongoose = require('mongoose')
const Schema = mongoose.Schema

// TicketType Schema
const ticketTypeSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    contractSessionId: {
      // ID dạng số (lưu trữ dưới dạng string) của Session để dùng với Contract
      type: String,
      required: true, // Sẽ được lấy từ Event.Session.contractSessionId khi tạo TicketType
      trim: true,
      index: true // Có thể index nếu bạn query theo trường này
    },
    blockchainEventId: { type: String, required: false, trim: true },
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
  'PENDING_PAYMENT', // 0
  'PAID', // 1
  'MINTING', // 2
  'MINT_FAILED', // 3
  'MINTED', // 4
  'FAILED_MINT' // 5
]
const ticketSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    ticketTypeId: { type: String, required: true, index: true }, // ref: 'TicketType'
    tokenId: { type: String, unique: true, sparse: true, trim: true },
    ownerAddress: { type: String, trim: true, lowercase: true, index: true },
    sessionId: { type: String, required: true },
    status: {
      type: String,
      enum: TICKET_STATUS_ENUM,
      default: 'PENDING_PAYMENT'
    },
    tokenUriCid: { type: String, required: false },
    transactionHash: { type: String, required: false },
    qrCodeData: {
      type: String,
      required: false,
      unique: true, // Đảm bảo mỗi QR code là duy nhất,
      sparse: true,
      index: true
    },
    qrCodeSecret: {
      type: String,
      required: false
    },
    checkInStatus: {
      type: String,
      enum: ['NOT_CHECKED_IN', 'CHECKED_IN', 'EXPIRED'],
      default: 'NOT_CHECKED_IN',
      index: true
    },
    checkInTime: {
      type: Date,
      default: null
    },
    checkInLocation: {
      type: String,
      default: ''
    },
    expiryTime: {
      type: Date,
      required: false
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id
        delete ret.__v
        delete ret.qrCodeSecret
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
