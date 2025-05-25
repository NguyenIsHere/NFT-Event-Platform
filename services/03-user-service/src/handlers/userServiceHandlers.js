const User = require('../models/User')
const { comparePassword } = require('../utils/passwordUtils')

// Hàm chuyển đổi user model sang UserResponse proto
function userToUserResponse (userDocument) {
  if (!userDocument) return null
  const userObj = userDocument.toObject ? userDocument.toObject() : userDocument
  return {
    id: userObj._id ? userObj._id.toString() : userObj.id,
    full_name: userObj.fullName || '',
    email: userObj.email || '',
    phone_number: userObj.phoneNumber || '',
    wallet_address: userObj.walletAddress || '',
    avatar_cid: userObj.avatarCid || '',
    ticket_ids: userObj.ticketIds || [],
    role: userObj.role || 'USER',
    created_at: userObj.createdAt
      ? userObj.createdAt.toISOString()
      : new Date().toISOString(),
    updated_at: userObj.updatedAt
      ? userObj.updatedAt.toISOString()
      : new Date().toISOString()
    // Lưu ý: Password không được trả về
  }
}

async function GetUserById (call, callback) {
  try {
    const user = await User.findById(call.request.user_id)
    if (!user) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'User not found'
      })
    }
    callback(null, userToUserResponse(user))
  } catch (error) {
    console.error('GetUserById Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Error retrieving user'
    })
  }
}

async function GetUserByEmail (call, callback) {
  try {
    const user = await User.findOne({ email: call.request.email })
    if (!user) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'User not found'
      })
    }
    callback(null, userToUserResponse(user))
  } catch (error) {
    console.error('GetUserByEmail Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Error retrieving user by email'
    })
  }
}

async function GetUserByWalletAddress (call, callback) {
  try {
    const user = await User.findOne({
      walletAddress: call.request.wallet_address
    })
    if (!user) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'User not found'
      })
    }
    callback(null, userToUserResponse(user))
  } catch (error) {
    console.error('GetUserByWalletAddress Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Error retrieving user by wallet address'
    })
  }
}

async function CreateUser (call, callback) {
  try {
    const {
      email,
      full_name,
      wallet_address,
      phone_number,
      password,
      role,
      avatar_cid
    } = call.request

    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'User with this email already exists'
      })
    }

    if (wallet_address) {
      const existingWalletUser = await User.findOne({
        walletAddress: wallet_address
      })
      if (existingWalletUser) {
        return callback({
          code: grpc.status.ALREADY_EXISTS,
          message: 'User with this wallet address already exists'
        })
      }
    }

    const newUser = new User({
      email,
      fullName: full_name,
      walletAddress: wallet_address,
      phoneNumber: phone_number,
      password, // Mongoose pre-save hook sẽ hash password này
      role: role || 'USER',
      avatarCid: avatar_cid
    })

    const savedUser = await newUser.save()
    callback(null, userToUserResponse(savedUser))
  } catch (error) {
    console.error('CreateUser Error:', error)
    // Xử lý lỗi validation của Mongoose
    if (error.name === 'ValidationError') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: Object.values(error.errors)
          .map(e => e.message)
          .join(', ')
      })
    }
    callback({
      code: grpc.status.INTERNAL,
      message: 'Error creating user'
    })
  }
}

async function AuthenticateUser (call, callback) {
  try {
    const { email, password } = call.request
    const user = await User.findOne({ email }) // Lấy cả password hash để so sánh

    if (!user) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'User not found'
      })
    }

    const isMatch = await user.comparePassword(password)
    if (!isMatch) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid credentials'
      })
    }
    // Trả về thông tin user, không bao gồm password (Mongoose model đã xử lý)
    callback(null, userToUserResponse(user))
  } catch (error) {
    console.error('AuthenticateUser Error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Error authenticating user'
    })
  }
}

// Cần import grpc ở đầu file để dùng grpc.status
const grpc = require('@grpc/grpc-js')

module.exports = {
  GetUserById,
  GetUserByEmail,
  GetUserByWalletAddress,
  CreateUser,
  AuthenticateUser
}
