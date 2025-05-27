// 04-event-service/src/models/Event.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const sessionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    startTime: { type: Number, required: true }, // Unix timestamp (seconds or milliseconds)
    endTime: { type: Number, required: true } // Unix timestamp
  },
  { _id: true, id: true }
) // id: true sẽ tự tạo virtual 'id' giống '_id'

// Middleware để thêm virtual 'id' cho session khi toJSON được gọi
sessionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret._id // Bỏ _id để chỉ dùng id
    delete ret.__v
    return ret
  }
})

const eventSchema = new Schema(
  {
    organizerId: {
      type: String,
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    location: {
      type: String,
      trim: true
    },
    bannerUrlCid: {
      type: String,
      trim: true
    },
    sessions: [sessionSchema],
    seatMapEnabled: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: false
    },
    blockchainEventId: {
      type: String, // Lưu uint256 từ contract
      sparse: true,
      unique: true, // Mỗi event trên DB chỉ map tới 1 event duy nhất trên blockchain
      trim: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true, // Đảm bảo virtual 'id' được bao gồm
      transform: (doc, ret) => {
        delete ret._id // Bỏ _id
        delete ret.__v
        // sessions đã có virtual 'id' từ schema của nó
        return ret
      }
    }
  }
)

// Tạo virtual 'id' để trả về giống _id
eventSchema.virtual('id').get(function () {
  return this._id.toHexString()
})

// Index cho các query thường xuyên
eventSchema.index({ name: 'text', description: 'text' })

const Event = mongoose.model('Event', eventSchema)
module.exports = Event
