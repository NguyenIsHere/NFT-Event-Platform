// Nơi tập trung export tất cả các gRPC clients
const authServiceClient = require('./authServiceClient')
const userServiceClient = require('./userServiceClient')
// const eventServiceClient = require('./eventServiceClient'); // Khi bạn tạo
// const ticketServiceClient = require('./ticketServiceClient'); // Khi bạn tạo

module.exports = {
  authServiceClient,
  userServiceClient
  // eventServiceClient,
  // ticketServiceClient,
  // ... các client khác
}
