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
const { Purchase } = require('../models/Purchase')
const {
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics
} = require('./analyticsHandlers')

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
      : 0
  }
}

async function InitiatePurchase (call, callback) {
  const {
    ticket_type_id,
    buyer_address,
    quantity = 1,
    selected_seats
  } = call.request
  console.log(
    `TicketService: InitiatePurchase called for ticket_type_id: ${ticket_type_id}, buyer: ${buyer_address}, quantity: ${quantity}`
  )

  try {
    // Validate inputs
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    if (
      !buyer_address ||
      typeof buyer_address !== 'string' ||
      !buyer_address.startsWith('0x')
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid buyer_address format.'
      })
    }

    const finalQuantity =
      selected_seats && selected_seats.length > 0
        ? selected_seats.length
        : quantity

    if (finalQuantity < 1 || finalQuantity > 10) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Quantity must be between 1 and 10.'
      })
    }

    // Get ticket type details
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    // ✅ FIX: Check if ticket type has blockchain_ticket_type_id
    if (
      !ticketType.blockchainTicketTypeId ||
      ticketType.blockchainTicketTypeId === '0'
    ) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message:
          'TicketType chưa được publish lên blockchain. Vui lòng liên hệ ban tổ chức.'
      })
    }

    // Check availability
    if (ticketType.availableQuantity < finalQuantity) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Not enough tickets available.'
      })
    }

    // Validate selected seats if provided
    const selectedSeatsArray = selected_seats || []
    if (selectedSeatsArray.length > 0) {
      // Check for seat conflicts
      const conflictingTickets = await Ticket.find({
        eventId: ticketType.eventId,
        'seatInfo.seatKey': { $in: selectedSeatsArray },
        status: { $in: ['PENDING_PAYMENT', 'PAID', 'MINTING', 'MINTED'] }
      })

      if (conflictingTickets.length > 0) {
        const conflictSeats = conflictingTickets.map(t => t.seatInfo.seatKey)
        return callback({
          code: grpc.status.ALREADY_EXISTS,
          message: `Seats already taken: ${conflictSeats.join(', ')}`
        })
      }
    }

    // ✅ FIX: Generate unique purchase ID
    const purchaseId = `purchase_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`

    // ✅ FIX: Get blockchain payment details
    const paymentDetailsResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetTicketPaymentDetails(
        {
          blockchain_event_id: ticketType.blockchainEventId || '0',
          price_wei_from_ticket_type: ticketType.priceWei
        },
        { deadline: new Date(Date.now() + 5000) },
        (err, res) => {
          if (err) {
            console.error('Error getting payment details:', err)
            reject(
              new Error('Failed to get payment details from blockchain service')
            )
          } else {
            resolve(res)
          }
        }
      )
    })

    // Create purchase details
    const purchaseDetails = {
      purchase_id: purchaseId,
      ticket_type_id,
      quantity: finalQuantity,
      wallet_address: buyer_address,
      selected_seats: selectedSeatsArray,
      payment_contract_address: paymentDetailsResponse.payment_contract_address,
      blockchain_event_id: ticketType.blockchainEventId,
      blockchain_ticket_type_id: ticketType.blockchainTicketTypeId, // ✅ ADD
      session_id_for_contract: ticketType.contractSessionId || '1',
      price_to_pay_wei: (
        BigInt(ticketType.priceWei) * BigInt(finalQuantity)
      ).toString(),
      unit_price_wei: ticketType.priceWei,
      total_price_wei: (
        BigInt(ticketType.priceWei) * BigInt(finalQuantity)
      ).toString(),
      event_id: ticketType.eventId,
      session_id: ticketType.sessionId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000)
    }

    // ✅ FIX: Store purchase details in database for later confirmation
    const purchaseRecord = new Purchase({
      purchaseId: purchaseId,
      ticketTypeId: ticket_type_id,
      quantity: finalQuantity,
      walletAddress: buyer_address,
      selectedSeats: selectedSeatsArray,
      status: 'INITIATED',
      expiresAt: purchaseDetails.expires_at,
      purchaseDetails: purchaseDetails
    })

    await purchaseRecord.save()

    // Create pending tickets để reserve seats
    const pendingTickets = []
    for (let i = 0; i < finalQuantity; i++) {
      const ticketData = {
        eventId: ticketType.eventId,
        ticketTypeId: ticket_type_id,
        ownerAddress: buyer_address.toLowerCase(),
        sessionId: ticketType.sessionId,
        status: 'PENDING_PAYMENT',
        expiryTime: purchaseDetails.expires_at
      }

      if (selectedSeatsArray.length > 0 && selectedSeatsArray[i]) {
        const seatKey = selectedSeatsArray[i]
        const parts = seatKey.split('-')
        if (parts.length >= 3) {
          ticketData.seatInfo = {
            seatKey: seatKey,
            section: parts[0],
            row: parts[1],
            seat: parts[2]
          }
        }
      }

      const ticket = new Ticket(ticketData)
      pendingTickets.push(ticket)
    }

    // Save all pending tickets
    await Ticket.insertMany(pendingTickets)

    // Temporarily reserve tickets
    ticketType.availableQuantity -= finalQuantity
    await ticketType.save()

    console.log(`✅ Purchase initiated: ${purchaseId}`)

    // ✅ FIX: Return the correct response format
    callback(null, {
      ticket_order_id: purchaseId,
      payment_contract_address: purchaseDetails.payment_contract_address,
      price_to_pay_wei: purchaseDetails.price_to_pay_wei,
      blockchain_event_id: purchaseDetails.blockchain_event_id,
      blockchain_ticket_type_id: purchaseDetails.blockchain_ticket_type_id, // ✅ ADD
      session_id_for_contract: purchaseDetails.session_id_for_contract,
      token_uri_cid: '',
      purchase_id: purchaseId
    })
  } catch (error) {
    console.error('TicketService: InitiatePurchase error:', error)

    // If seat conflict error, try to restore availability
    if (error.code === 11000 && error.message.includes('seatInfo.seatKey')) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: 'One or more selected seats are already taken.'
      })
    }

    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to initiate purchase.'
    })
  }
}

// ticketServiceHandlers.js - ConfirmPaymentAndRequestMint với validation
async function ConfirmPaymentAndRequestMint (call, callback) {
  const { ticket_order_id, payment_transaction_hash } = call.request
  console.log(
    `TicketService: ConfirmPaymentAndRequestMint called for order: ${ticket_order_id}, tx: ${payment_transaction_hash}`
  )

  try {
    // ✅ FIX: Find purchase record by purchaseId
    const purchase = await Purchase.findOne({ purchaseId: ticket_order_id })
    if (!purchase) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Purchase order not found.'
      })
    }

    if (purchase.status !== 'INITIATED') {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Purchase order is already ${purchase.status}.`
      })
    }

    // Validate transaction hash format
    if (
      !payment_transaction_hash ||
      !payment_transaction_hash.startsWith('0x')
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid transaction hash format.'
      })
    }

    // ✅ FIX: Find related pending tickets
    const relatedTickets = await Ticket.find({
      ownerAddress: purchase.walletAddress.toLowerCase(),
      ticketTypeId: purchase.ticketTypeId,
      status: 'PENDING_PAYMENT',
      createdAt: {
        $gte: new Date(purchase.createdAt.getTime() - 5 * 60 * 1000), // 5 minutes before
        $lte: new Date(purchase.createdAt.getTime() + 5 * 60 * 1000) // 5 minutes after
      }
    })

    if (relatedTickets.length === 0) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No pending tickets found for this purchase.'
      })
    }

    // Verify payment transaction
    const verificationResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash: payment_transaction_hash },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) {
            console.error('Error verifying transaction:', err)
            reject(new Error('Failed to verify transaction'))
          } else {
            resolve(res)
          }
        }
      )
    })

    if (
      !verificationResponse.is_confirmed ||
      !verificationResponse.success_on_chain
    ) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Transaction not confirmed or failed on blockchain.'
      })
    }

    // Update purchase status
    purchase.status = 'CONFIRMED'
    purchase.transactionHash = payment_transaction_hash
    await purchase.save()

    // Update tickets to PAID status
    await Ticket.updateMany(
      { _id: { $in: relatedTickets.map(t => t._id) } },
      {
        status: 'PAID',
        transactionHash: payment_transaction_hash
      }
    )

    // Get updated tickets
    const updatedTickets = await Ticket.find({
      _id: { $in: relatedTickets.map(t => t._id) }
    })

    console.log(
      `TicketService: Payment confirmed for ${updatedTickets.length} tickets`
    )

    // Return the first ticket (main ticket)
    callback(null, {
      ticket: ticketDocumentToGrpcTicket(updatedTickets[0]),
      tickets: updatedTickets.map(t => ticketDocumentToGrpcTicket(t)) // ✅ ADD: Return all tickets
    })
  } catch (error) {
    console.error('TicketService: ConfirmPaymentAndRequestMint error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to confirm payment and request mint.'
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
    // ✅ FIX: Better error mapping for QR verification
    const verification = verifyQRCodeData(qr_code_data, ticket.qrCodeSecret)
    if (!verification.valid) {
      // Map different failure reasons to appropriate status codes
      let statusCode = grpc.status.UNAUTHENTICATED
      let message = `QR code verification failed: ${verification.reason}`

      if (verification.reason === 'QR code expired') {
        statusCode = grpc.status.FAILED_PRECONDITION // 400 Bad Request
        message = 'QR code has expired. Please regenerate a new QR code.'
      } else if (verification.reason === 'Invalid signature') {
        statusCode = grpc.status.UNAUTHENTICATED // 401 Unauthorized
        message = 'QR code signature is invalid.'
      } else if (verification.reason === 'Invalid QR code format') {
        statusCode = grpc.status.INVALID_ARGUMENT // 400 Bad Request
        message = 'QR code format is invalid.'
      }

      console.log(`❌ QR verification failed: ${verification.reason}`)
      return callback({
        code: statusCode,
        message: message
      })
    }

    console.log(`✅ QR code verified successfully for ticket: ${ticket.id}`)

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

async function ListAllTickets (call, callback) {
  const { page_size = 20, page_token, status_filter } = call.request
  console.log(
    `TicketService: ListAllTickets called with page_size: ${page_size}`
  )

  try {
    const query = {}
    if (status_filter) {
      query.status = status_filter
    }

    // ✅ FIX: Handle page_size = 0 case
    const requestedPageSize = page_size || 20 // Default to 20 if 0 or undefined
    const limit = Math.min(requestedPageSize, 100)
    let skip = 0

    if (page_token) {
      try {
        skip = parseInt(page_token) || 0
      } catch (e) {
        skip = 0
      }
    }

    console.log(
      `TicketService: Querying tickets with limit: ${limit}, skip: ${skip}`
    )

    const tickets = await Ticket.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)

    const hasMore = tickets.length > limit
    const ticketsToReturn = hasMore ? tickets.slice(0, limit) : tickets
    const nextPageToken = hasMore ? (skip + limit).toString() : ''

    console.log(
      `TicketService: Returning ${ticketsToReturn.length} tickets, hasMore: ${hasMore}`
    )

    callback(null, {
      tickets: ticketsToReturn.map(ticketDocumentToGrpcTicket),
      next_page_token: nextPageToken
    })
  } catch (error) {
    console.error('TicketService: ListAllTickets RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list all tickets.'
    })
  }
}

async function GetSoldSeatsByEvent (call, callback) {
  const { event_id } = call.request
  console.log(
    `TicketService: GetSoldSeatsByEvent called for event: ${event_id}`
  )

  try {
    // Find all tickets for this event that have seat info and are sold/minted
    const soldTickets = await Ticket.find({
      eventId: event_id,
      'seatInfo.seatKey': { $exists: true },
      status: { $in: ['PAID', 'MINTING', 'MINTED'] }
    }).select('seatInfo.seatKey status')

    const soldSeatKeys = soldTickets.map(ticket => ({
      seat_key: ticket.seatInfo.seatKey,
      status: ticket.status
    }))

    console.log(
      `TicketService: Found ${soldSeatKeys.length} sold seats for event ${event_id}`
    )

    callback(null, {
      event_id,
      sold_seats: soldSeatKeys
    })
  } catch (error) {
    console.error('TicketService: GetSoldSeatsByEvent error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get sold seats.'
    })
  }
}

async function GetTicketMetadata (call, callback) {
  const { ticket_id } = call.request

  try {
    // Parse ticket_id to get purchase info
    const [purchaseId, ticketIndex] = ticket_id.split('_')

    const purchase = await Purchase.findOne({ purchaseId })
    if (!purchase) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Purchase not found'
      })
    }

    const ticketType = await TicketType.findById(purchase.ticketTypeId)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket type not found'
      })
    }

    // ✅ FIX: Get event details from event service
    const eventResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id: ticketType.eventId },
        { deadline: new Date(Date.now() + 5000) },
        (err, res) => {
          if (err) {
            console.error('Error getting event details:', err)
            reject(new Error('Failed to get event details'))
          } else {
            resolve(res)
          }
        }
      )
    })

    const event = eventResponse.event
    if (!event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Event not found'
      })
    }

    const metadata = {
      name: `${event.name} - ${ticketType.name}`,
      description: `Event ticket for ${event.name}`,
      image: event.banner_url_cid
        ? `${process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/'}${
            event.banner_url_cid
          }`
        : 'https://via.placeholder.com/300x300',
      attributes: [
        {
          trait_type: 'Event',
          value: event.name
        },
        {
          trait_type: 'Ticket Type',
          value: ticketType.name
        },
        {
          trait_type: 'Price',
          value: `${ethers.formatEther(ticketType.priceWei)} ETH`
        },
        {
          trait_type: 'Event ID',
          value: event.id
        },
        {
          trait_type: 'Session ID',
          value: ticketType.sessionId
        }
      ]
    }

    // Add seat info if available
    if (
      purchase.selectedSeats &&
      purchase.selectedSeats.length > parseInt(ticketIndex || '0')
    ) {
      const seatKey = purchase.selectedSeats[parseInt(ticketIndex || '0')]
      if (seatKey) {
        metadata.attributes.push({
          trait_type: 'Seat',
          value: seatKey
        })
      }
    }

    callback(null, { metadata: JSON.stringify(metadata) })
  } catch (error) {
    console.error('GetTicketMetadata error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to get ticket metadata'
    })
  }
}

module.exports = {
  InitiatePurchase,
  ConfirmPaymentAndRequestMint,
  GetTicketMetadata,
  GenerateQRCode,
  CheckIn,
  GetTicket,
  ListTicketsByEvent,
  ListTicketsByOwner,
  ListAllTickets,
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics,
  GetSoldSeatsByEvent
}
