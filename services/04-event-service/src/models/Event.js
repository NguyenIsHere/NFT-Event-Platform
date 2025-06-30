// 04-event-service/src/models/Event.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const EVENT_STATUS_ENUM = [
  'DRAFT',
  'PENDING_PUBLISH',
  'ACTIVE',
  'CANCELLED',
  'ENDED',
  'FAILED_PUBLISH'
]

const sessionSchema = new Schema(
  {
    // _id: Mongoose sẽ tự tạo, và virtual 'id' sẽ trỏ đến _id.toString()
    contractSessionId: {
      // ID dạng số để sử dụng với smart contract
      type: String, // Hoặc String nếu bạn muốn lưu số lớn và tự quản lý
      required: true
      // Bạn có thể thêm index nếu cần query theo trường này,
      // nhưng thường thì session là con của event.
    },
    name: { type: String, required: true, trim: true },
    startTime: { type: Number, required: true }, // Unix timestamp
    endTime: { type: Number, required: true } // Unix timestamp
  },
  {
    _id: true, // Mongoose tự tạo _id
    id: true // Tạo virtual 'id' từ _id
  }
)

sessionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret._id
    delete ret.__v
    return ret
  }
})
sessionSchema.virtual('id').get(function () {
  // Đây là MongoDB ObjectId string
  return this._id.toHexString()
})

const eventSchema = new Schema(
  {
    organizerId: {
      type: String,
      required: true,
      index: true
    },
    organizerWalletAddress: {
      // ✅ NEW: Store organizer wallet address
      type: String,
      required: false, // Optional vì có thể chưa có khi tạo event
      trim: true,
      lowercase: true
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
    sessions: [sessionSchema], // Mảng các session
    seatMapEnabled: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: EVENT_STATUS_ENUM,
      default: 'DRAFT',
      index: true
    },
    isActive: {
      type: Boolean,
      default: false
    },
    blockchainEventId: {
      type: String,
      sparse: true,
      // unique: true, // Bỏ unique ở đây nếu dùng schema.index() bên dưới
      trim: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id
        delete ret.__v
        return ret
      }
    }
  }
)

eventSchema.virtual('id').get(function () {
  return this._id.toHexString()
})

eventSchema.index({ name: 'text', description: 'text' })
// Giữ lại định nghĩa index này cho blockchainEventId, nó tốt hơn
eventSchema.index(
  { blockchainEventId: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      blockchainEventId: { $type: 'string', $ne: null, $ne: '' }
    }
  }
)
// Index cho mảng sessions nếu bạn cần query sâu vào các trường của session
// Ví dụ: eventSchema.index({ "sessions.contractSessionId": 1 });

const Event = mongoose.model('Event', eventSchema)
module.exports = { Event, EVENT_STATUS_ENUM }
