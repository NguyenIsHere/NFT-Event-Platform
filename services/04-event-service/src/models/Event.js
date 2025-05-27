// 04-event-service/src/models/Event.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const sessionSchema = new Schema(
  {
    // _id sẽ được mongoose tự tạo nếu không dùng làm id chính cho query
    // Hoặc bạn có thể tự định nghĩa nếu cần truy vấn Session độc lập:
    // id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    name: { type: String, required: true }, // Tên session (ví dụ: "Ngày 1 - Sáng", "Suất chiếu 19:00")
    startTime: { type: Number, required: true }, // Unix timestamp (seconds or milliseconds)
    endTime: { type: Number, required: true } // Unix timestamp
  },
  { _id: true }
) // _id: true để Mongoose tự tạo _id cho mỗi session nếu bạn muốn tham chiếu riêng

const eventSchema = new Schema(
  {
    organizerId: {
      // ID của người tổ chức (tham chiếu đến User model nếu có)
      type: String, // Hoặc mongoose.Schema.Types.ObjectId, ref: 'User'
      required: true
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
      // CID của ảnh banner trên IPFS
      type: String,
      trim: true
    },
    sessions: [sessionSchema], // Mảng các session, sessionSchema được định nghĩa ở trên
    seatMapEnabled: {
      type: Boolean,
      default: false
    },
    isActive: {
      // Sự kiện có đang mở bán vé không?
      type: Boolean,
      default: false
    },
    blockchainEventId: {
      // ID của sự kiện này trên Blockchain (nếu đã đăng ký)
      // Sẽ là string để lưu uint256 từ contract
      type: String,
      sparse: true, // Cho phép null/undefined và vẫn duy trì unique nếu bạn đặt unique: true
      // unique: true, // Cân nhắc nếu mỗi event trên DB chỉ map tới 1 event duy nhất trên blockchain
      trim: true
    }
  },
  {
    timestamps: true, // Tự động thêm createdAt và updatedAt
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id // Thêm trường 'id' giống như '_id'
        delete ret._id
        delete ret.__v
        // Chuyển đổi sessions để có 'id' thay vì '_id' nếu cần
        if (ret.sessions) {
          ret.sessions = ret.sessions.map(session => {
            if (session._id) {
              session.id = session._id.toString()
              delete session._id
            }
            return session
          })
        }
        return ret
      }
    }
  }
)

// Index nếu cần tìm kiếm thường xuyên
eventSchema.index({ organizerId: 1 })
eventSchema.index({ name: 'text', description: 'text' }) // Cho tìm kiếm text
if (
  eventSchema.paths.blockchainEventId &&
  eventSchema.paths.blockchainEventId.options.unique
) {
  eventSchema.index({ blockchainEventId: 1 }, { unique: true, sparse: true })
}

const Event = mongoose.model('Event', eventSchema)
module.exports = Event
