const mongoose = require('mongoose')
const Schema = mongoose.Schema
const { v4: uuidv4 } = require('uuid') // Để tạo ID nếu không muốn dùng ObjectId của Mongo

const refreshTokenSchema = new Schema({
  _id: {
    // Ghi đè _id mặc định nếu muốn dùng UUID
    type: String,
    default: uuidv4
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String, // Sẽ lưu _id của User từ UserService (dưới dạng String)
    required: true
  },
  expiryDate: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '7d' // Tự động xóa token hết hạn sau 7 ngày (hoặc khớp với JWT_REFRESH_TOKEN_EXPIRATION)
    // Lưu ý: 'expires' là tính năng của MongoDB TTL index, cần tạo index trên trường này.
  }
})

// Tạo TTL index trên createdAt
// Bạn cần chạy lệnh này trong mongo shell một lần để tạo index:
// db.refreshtokens.createIndex({ "createdAt": 1 }, { expireAfterSeconds: 604800 }) // 604800 giây = 7 ngày
// Hoặc cấu hình trong Mongoose:
// refreshTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }); // 7 days

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema)
module.exports = RefreshToken
