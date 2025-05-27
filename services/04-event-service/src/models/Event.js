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
    name: { type: String, required: true, trim: true },
    startTime: { type: Number, required: true }, // Unix timestamp (seconds or milliseconds)
    endTime: { type: Number, required: true } // Unix timestamp
  },
  {
    _id: true, // Mongoose sẽ tự tạo _id cho mỗi session
    id: true // Thêm virtual id
  }
)

sessionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    // ret.id = ret._id.toString(); // Đã có virtual id
    delete ret._id
    delete ret.__v
    return ret
  }
})
sessionSchema.virtual('id').get(function () {
  return this._id.toHexString()
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
    status: {
      // TRẠNG THÁI CỦA SỰ KIỆN
      type: String,
      enum: EVENT_STATUS_ENUM,
      default: 'DRAFT',
      index: true
    },
    isActive: {
      // Có thể được suy ra từ status, hoặc quản lý riêng
      type: Boolean,
      default: false // Mặc định không active khi mới tạo (draft)
    },
    blockchainEventId: {
      type: String,
      sparse: true,
      unique: true, // Chỉ duy nhất nếu trường này tồn tại và có giá trị
      trim: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        // ret.id = ret._id.toString(); // Đã có virtual id
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
if (
  eventSchema.paths.blockchainEventId &&
  eventSchema.paths.blockchainEventId.options.unique
) {
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
}

const Event = mongoose.model('Event', eventSchema)
module.exports = { Event, EVENT_STATUS_ENUM } // Export cả Enum nếu cần
