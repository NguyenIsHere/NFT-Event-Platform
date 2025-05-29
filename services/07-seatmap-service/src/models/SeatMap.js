// 07-seatmap-service/src/models/SeatMap.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const positionSchema = new Schema(
  {
    x: { type: Number, required: true, default: 0 },
    y: { type: Number, required: true, default: 0 },
    rotation: { type: Number, default: 0 }
  },
  { _id: false }
) // Không cần _id riêng cho Position nếu nó luôn được nhúng

const dimensionsSchema = new Schema(
  {
    width: { type: Number, required: true },
    height: { type: Number, required: true }
  },
  { _id: false }
) // Không cần _id riêng

const stageConfigSchema = new Schema(
  {
    dimensions: { type: dimensionsSchema, required: true },
    position: { type: positionSchema, required: true },
    shape: { type: String, trim: true } // ví dụ: "rectangle", "circle"
  },
  { _id: false }
)

const sectionSchema = new Schema(
  {
    // _id sẽ được Mongoose tự tạo và virtual 'id' sẽ trỏ đến nó
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true }, // ví dụ: "seated", "standing"
    position: { type: positionSchema, required: true },
    dimensions: { type: dimensionsSchema, required: true },
    rows: { type: Number, default: 0 },
    seats_per_row: { type: Number, default: 0 }, // Đổi tên từ proto cho nhất quán JS
    color: { type: String, trim: true },
    price_category_id: { type: String, trim: true }, // Có thể là ObjectId string nếu tham chiếu
    price_description: { type: String, trim: true }
  },
  {
    _id: true, // Cho phép Mongoose tự tạo _id cho mỗi section
    id: true // Thêm virtual 'id' (sẽ là string của _id)
  }
)

sectionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret._id
    delete ret.__v
    return ret
  }
})
sectionSchema.virtual('id').get(function () {
  return this._id.toHexString()
})

const seatMapSchema = new Schema(
  {
    eventId: {
      // ID của Event từ event-service mà seatmap này thuộc về
      type: String, // Hoặc mongoose.Schema.Types.ObjectId nếu bạn có ref chặt chẽ
      required: true,
      index: true,
      unique: true // Mỗi event thường chỉ có một seatmap
    },
    stageConfig: {
      // Đổi tên từ proto cho nhất quán JS
      type: stageConfigSchema,
      required: true
    },
    sections: [sectionSchema]
  },
  {
    timestamps: true, // Tự động thêm createdAt và updatedAt
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
seatMapSchema.virtual('id').get(function () {
  return this._id.toHexString()
})

const SeatMap = mongoose.model('SeatMap', seatMapSchema)
module.exports = SeatMap
