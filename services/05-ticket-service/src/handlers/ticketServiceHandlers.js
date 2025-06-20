// src/handlers/ticketServiceHandlers.js (trong 05-ticket-service)
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const ipfsServiceClient = require('../clients/ipfsServiceClient')
const blockchainServiceClient = require('../clients/blockchainServiceClient')
const eventServiceClient = require('../clients/eventServiceClient')
const {
  generateQRCodeData,
  verifyQRCodeData,
  generateQRCodeImage
} = require('../utils/qrCodeUtils')

// Helper function ticketDocumentToGrpcTicket (giữ nguyên như trước)
function ticketDocumentToGrpcTicket (ticketDoc) {
  if (!ticketDoc) return null
  const ticketJson = ticketDoc.toJSON ? ticketDoc.toJSON() : ticketDoc
  return {
    id: ticketJson.id,
    event_id: ticketJson.eventId || '',
    ticket_type_id: ticketJson.ticketTypeId || '',
    token_id: ticketJson.tokenId || '',
    owner_address: ticketJson.ownerAddress || '',
    session_id: ticketJson.sessionId || '',
    status: ticketJson.status || '',
    token_uri_cid: ticketJson.tokenUriCid || '',
    transaction_hash: ticketJson.transactionHash || '',
    created_at: ticketDoc.createdAt
      ? Math.floor(new Date(ticketDoc.createdAt).getTime() / 1000)
      : 0,
    // Thêm QR code fields
    qr_code_data: ticketJson.qrCodeData || '',
    check_in_status: ticketJson.checkInStatus || 'NOT_CHECKED_IN',
    check_in_time: ticketDoc.checkInTime
      ? Math.floor(new Date(ticketDoc.checkInTime).getTime() / 1000)
      : 0,
    check_in_location: ticketJson.checkInLocation || '',
    expiry_time: ticketDoc.expiryTime
      ? Math.floor(new Date(ticketDoc.expiryTime).getTime() / 1000)
      : 0,
    qr_code_image_url: ticketJson.id
      ? `/v1/tickets/${ticketJson.id}/qr-code/image`
      : ''
  }
}

async function InitiatePurchase (call, callback) {
  const { ticket_type_id, buyer_address } = call.request
  console.log(
    `TicketService: InitiatePurchase for ticket_type_id: ${ticket_type_id}, buyer: ${buyer_address}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id).lean()
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }
    if (ticketType.availableQuantity <= 0) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'This ticket type is sold out.'
      })
    }
    if (!ticketType.blockchainEventId) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message:
          'TicketType is not associated with a published blockchain event yet.'
      })
    }
    if (!ticketType.contractSessionId && ticketType.contractSessionId !== '0') {
      // Kiểm tra contractSessionId
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'TicketType is missing contract_session_id.'
      })
    }
    if (!buyer_address) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Buyer address is required.'
      })
    }

    // Lấy thông tin Event để làm phong phú metadata
    let eventName = 'Unknown Event'
    let eventBannerCid = 'YOUR_DEFAULT_TICKET_IMAGE_CID' // Nên có ảnh mặc định
    const eventDetailsResponse = await new Promise((resolve, reject) => {
      // Lấy thông tin Event
      eventServiceClient.GetEvent(
        { event_id: ticketType.eventId },
        { deadline: new Date(Date.now() + 5000) },
        (err, res) => {
          if (err) return reject(err)
          resolve(res)
        }
      )
    })
    if (eventDetailsResponse && eventDetailsResponse.event) {
      eventName = eventDetailsResponse.event.name
      if (eventDetailsResponse.event.banner_url_cid)
        eventBannerCid = eventDetailsResponse.event.banner_url_cid
    } else {
      console.warn(
        `TicketService: Could not fetch event details for eventId ${ticketType.eventId} during InitiatePurchase.`
      )
      // Có thể quyết định trả lỗi ở đây nếu thông tin event là bắt buộc cho metadata
    }

    // Tạo nội dung metadata cho NFT Ticket
    const nftMetadataContent = {
      name: `Ticket: ${ticketType.name} - Event: ${eventName}`,
      description: `Ticket for event "${eventName}". Type: ${
        ticketType.name
      }. Session ID (on chain): ${ticketType.sessionId || 'N/A'}.`,
      image: `ipfs://${eventBannerCid}`,
      external_url: `https://yourplatform.com/events/${ticketType.eventId}`,
      attributes: [
        { trait_type: 'Event Name', value: eventName },
        { trait_type: 'Ticket Type', value: ticketType.name },
        {
          trait_type: 'Event Blockchain ID',
          value: ticketType.blockchainEventId.toString()
        },
        {
          trait_type: 'Session On Chain',
          value: ticketType.sessionId || 'N/A'
        },
        { trait_type: 'Price (WEI)', value: ticketType.priceWei }
      ]
    }
    const jsonContentString = JSON.stringify(nftMetadataContent)

    // Upload metadata JSON lên IPFS
    console.log(
      `TicketService: Uploading NFT metadata to IPFS for ticket type ${ticket_type_id}`
    )
    const ipfsResponse = await new Promise((resolve, reject) => {
      ipfsServiceClient.PinJSONToIPFS(
        {
          json_content: jsonContentString,
          options: {
            pin_name: `ticket_meta_event_${
              ticketType.eventId
            }_tt_${ticket_type_id}_${Date.now()}`
          }
        },
        { deadline: new Date(Date.now() + 10000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })
    const tokenUriCidOnly = ipfsResponse.ipfs_hash // Đây là CID hash
    const fullTokenUriForContract = `ipfs://${tokenUriCidOnly}` // Tạo URI đầy đủ
    console.log(
      `TicketService: NFT metadata pinned to IPFS. Token URI for contract: ${fullTokenUriForContract}`
    )

    // Tạo bản ghi Ticket trong DB với trạng thái PENDING_PAYMENT
    const newTicketOrder = new Ticket({
      eventId: ticketType.eventId,
      ticketTypeId: ticket_type_id,
      ownerAddress: buyer_address.toLowerCase(), // Lưu địa chỉ người mua tiềm năng
      sessionId: ticketType.sessionId,
      status: TICKET_STATUS_ENUM[0], // PENDING_PAYMENT (Giả sử enum PENDING_PAYMENT là index 0)
      tokenUriCid: fullTokenUriForContract // Lưu CID của metadata (không có ipfs://)
      // transactionHash và tokenId sẽ được cập nhật sau
    })
    const savedTicketOrder = await newTicketOrder.save()
    console.log(
      `TicketService: Ticket order ${savedTicketOrder.id} created with status PENDING_PAYMENT.`
    )

    // Lấy thông tin thanh toán từ blockchain-service (địa chỉ contract và giá)
    const paymentDetails = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetTicketPaymentDetails(
        {
          blockchain_event_id: ticketType.blockchainEventId.toString(),
          price_wei_from_ticket_type: ticketType.priceWei
        },
        { deadline: new Date(Date.now() + 5000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    callback(null, {
      ticket_order_id: savedTicketOrder.id.toString(),
      payment_contract_address: paymentDetails.payment_contract_address,
      price_to_pay_wei: paymentDetails.price_to_pay_wei,
      blockchain_event_id: ticketType.blockchainEventId.toString(),
      session_id_for_contract: ticketType.contractSessionId.toString(),
      token_uri_cid: savedTicketOrder.tokenUriCid
    })
  } catch (error) {
    console.error(
      'TicketService: InitiatePurchase RPC error:',
      error.details || error.message || error
    )
    // ... (Xử lý lỗi)
    callback({
      code: grpc.status.INTERNAL,
      message:
        error.details || error.message || 'Failed to initiate ticket purchase.'
    })
  }
}

// async function ConfirmPaymentAndRequestMint (call, callback) {
//   const { ticket_order_id, payment_transaction_hash } = call.request
//   console.log(
//     `TicketService: ConfirmPaymentAndRequestMint for ticket_order_id: ${ticket_order_id}, payment_tx: ${payment_transaction_hash}`
//   )

//   try {
//     if (!mongoose.Types.ObjectId.isValid(ticket_order_id)) {
//       return callback({
//         code: grpc.status.INVALID_ARGUMENT,
//         message: 'Invalid ticket_order_id format.'
//       })
//     }
//     const ticketOrder = await Ticket.findById(ticket_order_id)
//     if (!ticketOrder) {
//       return callback({
//         code: grpc.status.NOT_FOUND,
//         message: 'Ticket order not found.'
//       })
//     }
//     if (ticketOrder.status !== TICKET_STATUS_ENUM[0]) {
//       // PENDING_PAYMENT
//       return callback({
//         code: grpc.status.FAILED_PRECONDITION,
//         message: `Ticket order is not awaiting payment. Current status: ${ticketOrder.status}`
//       })
//     }
//     if (!ticketOrder.tokenUriCid) {
//       return callback({
//         code: grpc.status.INTERNAL,
//         message:
//           'Ticket order is missing tokenUriCid, cannot proceed with minting.'
//       })
//     }

//     // 1. (Tùy chọn) Xác minh payment_transaction_hash (nếu là thanh toán off-chain hoặc on-chain vào ví Owner)
//     //    Nếu thanh toán on-chain vào contract EventTicketNFT (qua hàm buyTickets) thì logic sẽ khác.
//     //    Hiện tại, chúng ta giả định thanh toán đã được xác nhận bằng cách nào đó (ví dụ, admin duyệt)
//     //    và client gọi endpoint này để kích hoạt mint.
//     //    Nếu có `payment_transaction_hash`, bạn có thể gọi blockchainServiceClient.VerifyTransaction(payment_transaction_hash)
//     console.log(
//       `TicketService: Payment for order ${ticket_order_id} assumed confirmed (tx: ${payment_transaction_hash}). Proceeding to mint.`
//     )
//     ticketOrder.status = TICKET_STATUS_ENUM[1] // PAID (hoặc MINTING)
//     // ticketOrder.transactionHash = payment_transaction_hash; // Nếu tx này là tx mint thì sẽ cập nhật sau
//     await ticketOrder.save()

//     // 2. Lấy thông tin TicketType để biết blockchain_event_id và session_id
//     const ticketType = await TicketType.findById(
//       ticketOrder.ticketTypeId
//     ).lean()
//     if (
//       !ticketType ||
//       !ticketType.blockchainEventId ||
//       (!ticketType.contractSessionId && ticketType.contractSessionId !== '0')
//     ) {
//       throw new Error(
//         `TicketType ${ticketOrder.ticketTypeId} is missing blockchainEventId or contractSessionId.`
//       )
//     }

//     // 3. Gọi BlockchainService để mint vé
//     const fullTokenUriForContract = `ipfs://${ticketOrder.tokenUriCid}`
//     console.log(
//       `TicketService: Requesting mint from BlockchainService for order ${ticketOrder.id}, buyer: ${ticketOrder.ownerAddress}, URI: ${fullTokenUriForContract}`
//     )

//     const mintResponse = await new Promise((resolve, reject) => {
//       blockchainServiceClient.MintTicket(
//         {
//           buyer_address: ticketOrder.ownerAddress,
//           token_uri_cid: fullTokenUriForContract, // URI đầy đủ
//           blockchain_event_id: ticketType.blockchainEventId.toString(),
//           session_id_for_contract:
//             ticketType.contractSessionId.toString() || '0'
//         },
//         { deadline: new Date(Date.now() + 60000) }, // Timeout dài cho minting
//         (err, response) => {
//           if (err) return reject(err)
//           resolve(response)
//         }
//       )
//     })

//     if (mintResponse && mintResponse.success) {
//       // Cập nhật ticket với thông tin mint
//       ticketOrder.tokenId = mintResponse.token_id
//       ticketOrder.transactionHash = mintResponse.transaction_hash
//       ticketOrder.status = TICKET_STATUS_ENUM[4] // MINTED

//       if (
//         ticketOrder.ownerAddress.toLowerCase() !==
//         mintResponse.owner_address.toLowerCase()
//       ) {
//         ticketOrder.ownerAddress = mintResponse.owner_address.toLowerCase()
//       }

//       const savedTicket = await ticketOrder.save()

//       // TẠO QR CODE NGAY SAU KHI MINT THÀNH CÔNG
//       try {
//         const qrCodeInfo = generateQRCodeData({
//           ticketId: savedTicket.id,
//           eventId: savedTicket.eventId,
//           ownerAddress: savedTicket.ownerAddress
//         })

//         const expiryTime = new Date()
//         expiryTime.setFullYear(expiryTime.getFullYear() + 1)

//         savedTicket.qrCodeData = qrCodeInfo.qrCodeData
//         savedTicket.qrCodeSecret = qrCodeInfo.qrCodeSecret
//         savedTicket.expiryTime = expiryTime

//         const finalSavedTicket = await savedTicket.save()

//         console.log(
//           `TicketService: QR code generated for ticket ${finalSavedTicket.id}`
//         )

//         // Giảm available quantity
//         if (ticketType.availableQuantity > 0) {
//           await TicketType.findByIdAndUpdate(ticketOrder.ticketTypeId, {
//             $inc: { availableQuantity: -1 }
//           })
//         }

//         callback(null, { ticket: ticketDocumentToGrpcTicket(finalSavedTicket) })
//       } catch (qrError) {
//         console.error('TicketService: QR code generation failed:', qrError)
//         // QR code generation failure shouldn't fail the mint
//         callback(null, { ticket: ticketDocumentToGrpcTicket(savedTicket) })
//       }
//     } else {
//       ticketOrder.status = TICKET_STATUS_ENUM[5] // FAILED_MINT
//       await ticketOrder.save()
//       throw new Error(
//         mintResponse.message || 'Failed to mint NFT via BlockchainService.'
//       )
//     }
//   } catch (error) {
//     console.error(
//       'TicketService: ConfirmPaymentAndRequestMint RPC error:',
//       error
//     )
//     callback({
//       code: grpc.status.INTERNAL,
//       message: error.message || 'Failed to confirm payment and mint ticket.'
//     })
//   }
// }

// ticketServiceHandlers.js - ConfirmPaymentAndRequestMint
async function ConfirmPaymentAndRequestMint (call, callback) {
  const { ticket_order_id, payment_transaction_hash } = call.request

  try {
    const ticketOrder = await Ticket.findById(ticket_order_id)
    if (!ticketOrder) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket order not found.'
      })
    }

    // VERIFY TRANSACTION thay vì mint riêng
    const verifyResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash: payment_transaction_hash },
        { deadline: new Date(Date.now() + 10000) },
        (err, response) => {
          if (err) return reject(err)
          resolve(response)
        }
      )
    })

    if (!verifyResponse.is_confirmed || !verifyResponse.success_on_chain) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Transaction not confirmed or failed on-chain'
      })
    }

    // Parse transaction logs để lấy tokenId từ TicketMinted event
    let mintedTokenId = '0'
    try {
      // Gọi blockchain service để parse logs
      const parseLogsResponse = await new Promise((resolve, reject) => {
        blockchainServiceClient.ParseTransactionLogs(
          { transaction_hash: payment_transaction_hash },
          { deadline: new Date(Date.now() + 5000) },
          (err, response) => {
            if (err) return reject(err)
            resolve(response)
          }
        )
      })

      if (parseLogsResponse.minted_token_id) {
        mintedTokenId = parseLogsResponse.minted_token_id
      }
    } catch (parseError) {
      console.warn('Could not parse transaction logs:', parseError.message)
    }

    // Cập nhật ticket với thông tin từ blockchain
    ticketOrder.status = TICKET_STATUS_ENUM[4] // MINTED
    ticketOrder.transactionHash = payment_transaction_hash
    ticketOrder.tokenId = mintedTokenId

    const savedTicket = await ticketOrder.save()

    // Tạo QR code
    const qrCodeInfo = generateQRCodeData({
      ticketId: savedTicket.id,
      eventId: savedTicket.eventId,
      ownerAddress: savedTicket.ownerAddress
    })

    savedTicket.qrCodeData = qrCodeInfo.qrCodeData
    savedTicket.qrCodeSecret = qrCodeInfo.qrCodeSecret
    savedTicket.expiryTime = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)

    const finalTicket = await savedTicket.save()

    // Decrease available quantity
    const ticketType = await TicketType.findById(ticketOrder.ticketTypeId)
    if (ticketType && ticketType.availableQuantity > 0) {
      await TicketType.findByIdAndUpdate(ticketOrder.ticketTypeId, {
        $inc: { availableQuantity: -1 }
      })
    }

    callback(null, { ticket: ticketDocumentToGrpcTicket(finalTicket) })
  } catch (error) {
    console.error('ConfirmPaymentAndRequestMint error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to confirm payment'
    })
  }
}

async function GenerateQRCode (call, callback) {
  const { ticket_id } = call.request

  console.log(`TicketService: GenerateQRCode called for ticket: ${ticket_id}`)

  try {
    // Tìm ticket
    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found'
      })
    }

    // Kiểm tra ticket status
    if (ticket.status !== TICKET_STATUS_ENUM[4]) {
      // MINTED
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Ticket must be minted before generating QR code'
      })
    }

    // Tạo QR code nếu chưa có
    if (!ticket.qrCodeData) {
      const qrCodeInfo = generateQRCodeData({
        ticketId: ticket.id,
        eventId: ticket.eventId,
        ownerAddress: ticket.ownerAddress
      })

      const expiryTime = new Date()
      expiryTime.setFullYear(expiryTime.getFullYear() + 1)

      ticket.qrCodeData = qrCodeInfo.qrCodeData
      ticket.qrCodeSecret = qrCodeInfo.qrCodeSecret
      ticket.expiryTime = expiryTime

      await ticket.save()
    }

    // Tạo QR code image
    const qrCodeImageBase64 = await generateQRCodeImage(ticket.qrCodeData)

    callback(null, {
      success: true,
      message: 'QR code generated successfully',
      qr_code_data: ticket.qrCodeData,
      qr_code_image_base64: qrCodeImageBase64
    })
  } catch (error) {
    console.error('TicketService: GenerateQRCode error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to generate QR code'
    })
  }
}

// Thêm handler cho CheckIn
async function CheckIn (call, callback) {
  const { qr_code_data, location, scanner_id } = call.request

  console.log(`TicketService: CheckIn called with scanner: ${scanner_id}`)

  try {
    // Parse QR code data
    let qrData
    try {
      qrData = JSON.parse(qr_code_data)
    } catch (error) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid QR code format'
      })
    }

    // Tìm ticket bằng QR code data
    const ticket = await Ticket.findOne({ qrCodeData: qr_code_data })
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found or QR code invalid'
      })
    }

    // Verify QR code signature
    const verification = verifyQRCodeData(qr_code_data, ticket.qrCodeSecret)
    if (!verification.valid) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: `QR code verification failed: ${verification.reason}`
      })
    }

    // Kiểm tra ticket status
    if (ticket.status !== TICKET_STATUS_ENUM[4]) {
      // MINTED
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Ticket is not valid for check-in'
      })
    }

    // Kiểm tra expiry
    if (ticket.expiryTime && new Date() > ticket.expiryTime) {
      ticket.checkInStatus = 'EXPIRED'
      await ticket.save()

      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Ticket has expired'
      })
    }

    // Kiểm tra đã check-in chưa
    if (ticket.checkInStatus === 'CHECKED_IN') {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `Ticket already checked in at ${ticket.checkInTime} (${ticket.checkInLocation})`
      })
    }

    // Thực hiện check-in
    ticket.checkInStatus = 'CHECKED_IN'
    ticket.checkInTime = new Date()
    ticket.checkInLocation = location || 'Unknown'

    await ticket.save()

    console.log(`TicketService: Ticket ${ticket.id} checked in successfully`)

    callback(null, {
      success: true,
      message: 'Check-in successful',
      ticket: ticketDocumentToGrpcTicket(ticket)
    })
  } catch (error) {
    console.error('TicketService: CheckIn error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Check-in failed'
    })
  }
}

async function GetTicket (call, callback) {
  const { ticket_id } = call.request
  console.log(`TicketService: GetTicket called for ID: ${ticket_id}`)

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket ID format.'
      })
    }

    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found.'
      })
    }

    callback(null, ticketDocumentToGrpcTicket(ticket))
  } catch (error) {
    console.error('TicketService: GetTicket RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get ticket.'
    })
  }
}

async function ListTicketsByEvent (call, callback) {
  const { event_id, page_size = 10, page_token } = call.request
  console.log(`TicketService: ListTicketsByEvent called for event: ${event_id}`)

  try {
    const query = { eventId: event_id }
    const limit = Math.min(page_size, 100)
    let skip = 0

    if (page_token) {
      try {
        skip = parseInt(page_token)
      } catch (e) {
        skip = 0
      }
    }

    const tickets = await Ticket.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)

    const hasMore = tickets.length > limit
    const ticketsToReturn = hasMore ? tickets.slice(0, limit) : tickets
    const nextPageToken = hasMore ? (skip + limit).toString() : ''

    callback(null, {
      tickets: ticketsToReturn.map(ticketDocumentToGrpcTicket),
      next_page_token: nextPageToken
    })
  } catch (error) {
    console.error('TicketService: ListTicketsByEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list tickets.'
    })
  }
}

async function ListTicketsByOwner (call, callback) {
  const { owner_address, page_size = 10, page_token } = call.request
  console.log(
    `TicketService: ListTicketsByOwner called for owner: ${owner_address}`
  )

  try {
    const query = { ownerAddress: owner_address.toLowerCase() }
    const limit = Math.min(page_size, 100)
    let skip = 0

    if (page_token) {
      try {
        skip = parseInt(page_token)
      } catch (e) {
        skip = 0
      }
    }

    const tickets = await Ticket.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)

    const hasMore = tickets.length > limit
    const ticketsToReturn = hasMore ? tickets.slice(0, limit) : tickets
    const nextPageToken = hasMore ? (skip + limit).toString() : ''

    callback(null, {
      tickets: ticketsToReturn.map(ticketDocumentToGrpcTicket),
      next_page_token: nextPageToken
    })
  } catch (error) {
    console.error('TicketService: ListTicketsByOwner RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list tickets.'
    })
  }
}

module.exports = {
  InitiatePurchase,
  ConfirmPaymentAndRequestMint,
  GenerateQRCode,
  CheckIn,
  GetTicket,
  ListTicketsByEvent,
  ListTicketsByOwner
}
