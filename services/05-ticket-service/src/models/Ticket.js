// 05-ticket-service/src/models/Ticket.js
const mongoose = require('mongoose') // Đã require ở trên nếu cùng file, tách file thì require lại
const Schema = mongoose.Schema

// Định nghĩa các trạng thái vé có thể có
const TICKET_STATUS_ENUM = [
  'AVAILABLE',
  'SOLD',
  'USED',
  'CANCELLED',
  'PENDING_MINT'
]

const ticketSchema = new Schema(
  {
    eventId: {
      // ID của Event từ event-service
      type: String, // Hoặc mongoose.Schema.Types.ObjectId, ref: 'Event'
      required: true
    },
    ticketTypeId: {
      // ID của TicketType
      type: String, // Hoặc mongoose.Schema.Types.ObjectId, ref: 'TicketType'
      required: true
    },
    tokenId: {
      // ID của NFT trên blockchain (uint256 từ contract, lưu dạng string)
      type: String, // Sẽ được cập nhật sau khi mint thành công
      unique: true,
      sparse: true, // Cho phép null/undefined trước khi mint
      trim: true
    },
    ownerAddress: {
      // Địa chỉ ví sở hữu vé NFT
      type: String, // Sẽ được cập nhật sau khi mint hoặc transfer
      trim: true,
      lowercase: true
    },
    sessionId: {
      // ID của session trong Event (nếu vé này dành cho session cụ thể)
      // Có thể là string (nếu session ID trên contract là uint256)
      // Hoặc ObjectId nếu bạn muốn quản lý Session như một collection riêng và ref tới _id của nó
      type: String,
      required: false // Tùy theo logic vé của bạn
    },
    status: {
      type: String,
      enum: TICKET_STATUS_ENUM,
      default: 'AVAILABLE' // Hoặc PENDING_MINT nếu tạo trước khi mint
    },
    tokenUriCid: {
      // CID của metadata JSON cho vé này (đã upload qua ipfs-service)
      type: String,
      required: false // Sẽ có khi chuẩn bị mint
    },
    transactionHash: {
      // Hash của giao dịch mint vé trên blockchain
      type: String,
      required: false // Sẽ có sau khi giao dịch được gửi
    }
    // qrCodeData: String, // Dữ liệu mã QR, có thể tạo sau
  },
  {
    timestamps: true, // Tự động thêm createdAt và updatedAt
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id
        delete ret._id
        delete ret.__v
        return ret
      }
    }
  }
)

ticketSchema.index({ eventId: 1, ticketTypeId: 1 })
ticketSchema.index({ ownerAddress: 1 })
if (ticketSchema.paths.tokenId && ticketSchema.paths.tokenId.options.unique) {
  ticketSchema.index({ tokenId: 1 }, { unique: true, sparse: true })
}

const Ticket = mongoose.model('Ticket', ticketSchema)

module.exports = { Ticket, TICKET_STATUS_ENUM } // Export cả enum nếu cần dùng ở service
