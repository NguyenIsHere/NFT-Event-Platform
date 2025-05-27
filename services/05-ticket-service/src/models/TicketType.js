// 05-ticket-service/src/models/TicketType.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const ticketTypeSchema = new Schema(
  {
    eventId: {
      // ID của Event từ event-service (tham chiếu đến Event model)
      type: String, // Hoặc mongoose.Schema.Types.ObjectId, ref: 'Event' (nếu Event service quản lý)
      required: true
    },
    blockchainEventId: {
      // ID của Event trên Blockchain (uint256 từ contract, lưu dạng string)
      type: String,
      required: true, // Cần để biết mint vé cho event nào trên contract
      trim: true
    },
    name: {
      // Tên loại vé (ví dụ: "Vé Thường", "Vé VIP")
      type: String,
      required: true,
      trim: true
    },
    totalQuantity: {
      type: Number, // int32 từ proto
      required: true
    },
    availableQuantity: {
      type: Number, // int32 từ proto
      required: true
    },
    priceWei: {
      // Giá vé dưới dạng chuỗi số nguyên lớn (Wei)
      type: String,
      required: true
    }
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

ticketTypeSchema.index({ eventId: 1 })
ticketTypeSchema.index({ eventId: 1, name: 1 }, { unique: true }) // Mỗi event không nên có 2 loại vé trùng tên

const TicketType = mongoose.model('TicketType', ticketTypeSchema)
module.exports = TicketType
