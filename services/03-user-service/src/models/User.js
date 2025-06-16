const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const Schema = mongoose.Schema

const userSchema = new Schema(
  {
    fullName: {
      type: String,
      required: false // Dựa trên CreateUserRequest, full_name có thể không bắt buộc lúc đầu
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    phoneNumber: {
      type: String,
      required: false,
      trim: true
    },
    password: {
      type: String,
      required: true
    },
    walletAddress: {
      type: String,
      required: false, // Dựa trên CreateUserRequest
      trim: true,
      unique: true,
      sparse: true // Cho phép nhiều document có giá trị null/undefined cho trường unique này
    },
    avatarCid: {
      // CID avatar trên IPFS
      type: String,
      required: false
    },
    ticketIds: [
      {
        // Danh sách ID vé mà user sở hữu (lưu ý: có thể cần xem xét lại cách lưu trữ này)
        type: String // Hoặc mongoose.Schema.Types.ObjectId nếu tham chiếu đến collection khác
      }
    ],
    role: {
      // Vai trò: USER, ORGANIZER, ADMIN
      type: String,
      enum: ['USER', 'ORGANIZER', 'ADMIN'],
      default: 'USER'
    }
  },
  {
    timestamps: true // Tự động thêm createdAt và updatedAt
  }
)

// Middleware để hash password trước khi lưu (chỉ khi password được thay đổi)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next()
  }
  try {
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    next()
  } catch (error) {
    next(error)
  }
})

// Method để so sánh password (không trả về password hash trong các query mặc định)
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password)
}

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.password // Không trả về password khi chuyển thành JSON
    return ret
  }
})

const User = mongoose.model('User', userSchema)
module.exports = User
