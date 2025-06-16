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
      wallet_address, // từ gRPC request
      phone_number,
      password,
      role,
      avatar_cid
    } = call.request

    // 1. Kiểm tra email đã tồn tại chưa
    const existingUserByEmail = await User.findOne({ email })
    if (existingUserByEmail) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'User with this email already exists'
      })
    }

    // 2. Xử lý wallet_address: chuyển "" thành undefined
    let processedWalletAddress = wallet_address
    if (wallet_address === '') {
      processedWalletAddress = undefined
    }

    // 3. Kiểm tra walletAddress đã tồn tại chưa (chỉ khi processedWalletAddress có giá trị thực sự)
    if (processedWalletAddress) {
      // Sẽ bỏ qua nếu processedWalletAddress là undefined
      const existingUserByWallet = await User.findOne({
        walletAddress: processedWalletAddress
      })
      if (existingUserByWallet) {
        return callback({
          code: grpc.status.ALREADY_EXISTS,
          message: 'User with this wallet address already exists'
        })
      }
    }

    // 4. Tạo người dùng mới
    const newUser = new User({
      email,
      fullName: full_name, // Ánh xạ full_name từ request sang fullName trong model
      walletAddress: processedWalletAddress, // Sử dụng giá trị đã xử lý
      phoneNumber: phone_number,
      password, // Hook pre-save của Mongoose sẽ hash password này
      role: role || 'USER', // Gán vai trò mặc định nếu không được cung cấp
      avatarCid: avatar_cid
    })

    const savedUser = await newUser.save() // Việc save() bây giờ sẽ không gây lỗi E11000 cho nhiều walletAddress rỗng (thành undefined) nữa

    // 5. Trả về response
    callback(null, userToUserResponse(savedUser))
  } catch (error) {
    console.error('CreateUser Error in UserService:', error) // Log lỗi chi tiết ở user-service

    // Xử lý lỗi validation của Mongoose
    if (error.name === 'ValidationError') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: Object.values(error.errors)
          .map(e => e.message)
          .join(', ')
      })
    }

    // Xử lý lỗi duplicate key từ MongoDB (E11000) nếu các kiểm tra findOne ở trên bỏ sót (ví dụ do race condition)
    if (error.code === 11000) {
      let duplicateField = 'Unknown unique field'
      // Phân tích chi tiết hơn lỗi E11000 nếu cần, ví dụ dựa vào error.keyPattern hoặc error.keyValue
      if (error.message && error.message.includes('email_1')) {
        // Giả sử index của email có tên 'email_1'
        duplicateField = 'Email'
      } else if (error.message && error.message.includes('walletAddress_1')) {
        // Lỗi này xảy ra nếu một walletAddress cụ thể (không rỗng) bị trùng
        duplicateField = 'Wallet address'
      }
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `${duplicateField} already exists (database constraint).`
      })
    }

    // Các lỗi không xác định khác
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Error creating user in UserService' // Cung cấp thông báo lỗi rõ hơn nếu có
    })
  }
}

async function AuthenticateUser (call, callback) {
  const { email, password } = call.request
  console.log(`UserService: AuthenticateUser called for email: ${email}`)

  try {
    // Tìm user theo email
    const user = await User.findOne({ email })
    if (!user) {
      console.log(`UserService: User not found for email: ${email}`)
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'User not found'
      })
    }

    // Kiểm tra password using comparePassword method from model
    const isPasswordValid = await user.comparePassword(password)
    if (!isPasswordValid) {
      console.log(`UserService: Invalid password for email: ${email}`)
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid password'
      })
    }

    console.log(`UserService: User authenticated successfully: ${user._id}`)

    // Trả về thông tin user
    callback(null, userToUserResponse(user))
  } catch (error) {
    console.error('UserService: AuthenticateUser RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to authenticate user.'
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
