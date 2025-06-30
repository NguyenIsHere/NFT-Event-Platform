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
  GetCheckinAnalytics,
  GetPurchaseAnalytics
} = require('./analyticsHandlers')
const ethers = require('ethers')

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
    seat_info: ticketJson.seatInfo
      ? {
          seat_key: ticketJson.seatInfo.seatKey || '',
          section: ticketJson.seatInfo.section || '',
          row: ticketJson.seatInfo.row || '',
          seat: ticketJson.seatInfo.seat || ''
        }
      : null
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
    // ✅ FIX: Better availability management with real-time calculation
    const currentAvailability = await TicketType.findById(ticket_type_id)
    if (!currentAvailability) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    // ✅ FIX: Calculate real availability from database
    const soldTicketsCount = await Ticket.countDocuments({
      ticketTypeId: ticket_type_id,
      status: { $in: ['MINTED'] } // Only count actually minted tickets
    })

    const reservedTicketsCount = await Ticket.countDocuments({
      ticketTypeId: ticket_type_id,
      status: { $in: ['PENDING_PAYMENT', 'PAID', 'MINTING'] }, // Include all "in-process" tickets
      expiryTime: { $gt: new Date() } // Only count non-expired reservations
    })

    const realAvailableQuantity = Math.max(
      0,
      currentAvailability.totalQuantity -
        soldTicketsCount -
        reservedTicketsCount
    )

    console.log('📊 Availability check:', {
      ticketTypeId: ticket_type_id,
      totalQuantity: currentAvailability.totalQuantity,
      soldTickets: soldTicketsCount,
      reservedTickets: reservedTicketsCount,
      requestedQuantity: finalQuantity,
      realAvailable: realAvailableQuantity,
      dbAvailable: currentAvailability.availableQuantity
    })

    if (realAvailableQuantity < finalQuantity) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Chỉ còn ${realAvailableQuantity} vé có sẵn, bạn đang yêu cầu ${finalQuantity} vé.`
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
        const [section, row, seat] = seatKey.split('-')

        ticketData.seatInfo = {
          seatKey: seatKey,
          section: section,
          row: row,
          seat: seat
        }
      }

      const ticket = new Ticket(ticketData)
      pendingTickets.push(ticket)
    }

    // Save all pending tickets
    await Ticket.insertMany(pendingTickets)

    // ✅ FIX: Update availability to reflect reservation (but don't over-subtract)
    const newAvailableAfterReservation = realAvailableQuantity - finalQuantity
    if (
      currentAvailability.availableQuantity !== newAvailableAfterReservation
    ) {
      currentAvailability.availableQuantity = newAvailableAfterReservation
      await currentAvailability.save()
      console.log(
        `✅ Updated availability after reservation: ${currentAvailability.availableQuantity}`
      )
    }

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

// ticketServiceHandlers.js - ConfirmPaymentAndRequestMint với auto QR generation
async function ConfirmPaymentAndRequestMint (call, callback) {
  const { ticket_order_id, payment_transaction_hash } = call.request
  console.log(
    `TicketService: ConfirmPaymentAndRequestMint called for order: ${ticket_order_id}, tx: ${payment_transaction_hash}`
  )

  // ✅ FIX: Add detailed request logging
  console.log('📋 Full request object:', {
    ticket_order_id,
    payment_transaction_hash,
    requestKeys: Object.keys(call.request || {}),
    requestType: typeof call.request
  })

  try {
    // ✅ FIX: Validate inputs with detailed logging
    if (!ticket_order_id) {
      console.error('❌ Missing ticket_order_id in request')
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'ticket_order_id is required'
      })
    }

    if (!payment_transaction_hash) {
      console.error('❌ Missing payment_transaction_hash in request')
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'payment_transaction_hash is required'
      })
    }

    // Validate transaction hash format
    if (
      payment_transaction_hash.length !== 66 ||
      !payment_transaction_hash.startsWith('0x')
    ) {
      console.error(
        '❌ Invalid transaction hash format:',
        payment_transaction_hash
      )
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid transaction hash format'
      })
    }

    console.log(
      `🔍 Processing payment confirmation for order: ${ticket_order_id}`
    )

    // ✅ FIX: Find purchase record with detailed logging
    console.log(`🔍 Looking for purchase with purchaseId: ${ticket_order_id}`)

    const purchase = await Purchase.findOne({ purchaseId: ticket_order_id })

    if (!purchase) {
      console.error('❌ Purchase not found with purchaseId:', ticket_order_id)

      // ✅ DEBUG: Log all purchases to see what's in DB
      const allPurchases = await Purchase.find({})
        .select('purchaseId status')
        .limit(5)
      console.log('📋 Available purchases in DB:', allPurchases)

      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Purchase order not found.'
      })
    }

    console.log('✅ Found purchase:', {
      purchaseId: purchase.purchaseId,
      status: purchase.status,
      ticketTypeId: purchase.ticketTypeId,
      quantity: purchase.quantity,
      walletAddress: purchase.walletAddress,
      hasMetadataUris: !!(
        purchase.metadataUris && purchase.metadataUris.length > 0
      ),
      metadataUrisCount: purchase.metadataUris?.length || 0
    })

    if (purchase.status !== 'INITIATED') {
      console.error('❌ Invalid purchase status:', purchase.status)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Purchase order is in ${purchase.status} status, cannot confirm.`
      })
    }

    // ✅ FIX: Check if metadata URIs were prepared
    if (!purchase.metadataUris || purchase.metadataUris.length === 0) {
      console.error('❌ Metadata not prepared for purchase:', ticket_order_id)
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Metadata not prepared. Please prepare metadata first.'
      })
    }

    console.log(`📋 Purchase details:`, {
      purchaseId: purchase.purchaseId,
      quantity: purchase.quantity,
      metadataUrisCount: purchase.metadataUris.length,
      walletAddress: purchase.walletAddress,
      status: purchase.status
    })

    // ✅ FIX: Verify transaction first before parsing logs
    console.log('🔍 Verifying transaction on blockchain...')
    const verifyResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash: payment_transaction_hash },
        { deadline: new Date(Date.now() + 15000) },
        (err, res) => {
          if (err) {
            console.error('❌ VerifyTransaction error:', err)
            reject(err)
          } else {
            console.log('✅ VerifyTransaction response:', res)
            resolve(res)
          }
        }
      )
    })

    if (!verifyResponse.is_confirmed) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message:
          'Transaction not yet confirmed on blockchain. Please wait and try again.'
      })
    }

    if (!verifyResponse.success_on_chain) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: 'Transaction failed on blockchain'
      })
    }

    console.log('✅ Transaction verified on blockchain')

    // Parse transaction logs to get minted token IDs
    console.log('📋 Parsing transaction logs...')
    const parseLogsResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.ParseTransactionLogs(
        { transaction_hash: payment_transaction_hash },
        { deadline: new Date(Date.now() + 15000) },
        (err, res) => {
          if (err) {
            console.error('❌ ParseTransactionLogs error:', err)
            reject(err)
          } else {
            console.log('✅ ParseTransactionLogs response:', res)
            resolve(res)
          }
        }
      )
    })

    if (!parseLogsResponse.success) {
      throw new Error(
        'Failed to parse transaction logs: ' +
          (parseLogsResponse.message || 'Unknown error')
      )
    }

    // ✅ FIX: Get minted token IDs from logs
    const mintedTokenIds = []
    if (
      parseLogsResponse.minted_token_ids &&
      parseLogsResponse.minted_token_ids.length > 0
    ) {
      mintedTokenIds.push(...parseLogsResponse.minted_token_ids)
    } else if (parseLogsResponse.minted_token_id) {
      mintedTokenIds.push(parseLogsResponse.minted_token_id)
    }

    console.log(
      `🎯 Found ${mintedTokenIds.length} minted token IDs:`,
      mintedTokenIds
    )

    // Find related pending tickets
    const relatedTickets = await Ticket.find({
      ownerAddress: purchase.walletAddress.toLowerCase(),
      ticketTypeId: purchase.ticketTypeId,
      status: 'PENDING_PAYMENT',
      createdAt: {
        $gte: new Date(purchase.createdAt.getTime() - 5 * 60 * 1000),
        $lte: new Date(purchase.createdAt.getTime() + 5 * 60 * 1000)
      }
    }).sort({ createdAt: 1 }) // Sort by creation time

    if (relatedTickets.length === 0) {
      console.error('❌ No pending tickets found for purchase:', {
        walletAddress: purchase.walletAddress,
        ticketTypeId: purchase.ticketTypeId,
        purchaseCreatedAt: purchase.createdAt
      })

      // ✅ DEBUG: Check all tickets for this user
      const allUserTickets = await Ticket.find({
        ownerAddress: purchase.walletAddress.toLowerCase()
      })
        .select('status createdAt ticketTypeId')
        .limit(10)
      console.log('📋 All user tickets:', allUserTickets)

      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No pending tickets found for this purchase.'
      })
    }

    console.log(`🎫 Found ${relatedTickets.length} tickets to process`)

    // ✅ FIX: Ensure we have enough metadata URIs
    if (purchase.metadataUris.length < relatedTickets.length) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Insufficient metadata URIs. Expected: ${relatedTickets.length}, Found: ${purchase.metadataUris.length}`
      })
    }

    // Update purchase status first
    purchase.status = 'CONFIRMED'
    purchase.transactionHash = payment_transaction_hash
    await purchase.save()

    // ✅ FIX: Get event data to set proper expiry times
    let eventData = null
    try {
      const eventResponse = await new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id: purchase.purchaseDetails.event_id },
          (err, response) => {
            if (err) reject(err)
            else resolve(response)
          }
        )
      })
      eventData = eventResponse.event
    } catch (eventError) {
      console.warn('Could not fetch event data:', eventError)
    }

    // Process each ticket
    // Process each ticket
    const updatedTickets = []
    for (let i = 0; i < relatedTickets.length; i++) {
      const relatedTicket = relatedTickets[i]
      const tokenId = mintedTokenIds[i]
      const metadataUri = purchase.metadataUris[i]

      // ✅ FIX: Set expiry time based on session end time
      let expiryTime = null
      if (eventData && eventData.sessions) {
        const ticketSession = eventData.sessions.find(
          s => s.id === relatedTicket.sessionId
        )
        if (ticketSession) {
          expiryTime = new Date(ticketSession.end_time * 1000)
        } else if (eventData.sessions.length > 0) {
          // Fallback to first session
          expiryTime = new Date(eventData.sessions[0].end_time * 1000)
        }
      }

      // If we still don't have expiry time, set to 30 days from now
      if (!expiryTime) {
        expiryTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }

      // ✅ FIX: Auto-generate QR code for minted tickets
      const qrData = generateQRCodeData({
        ticketId: relatedTicket.id,
        eventId: relatedTicket.eventId,
        ownerAddress: relatedTicket.ownerAddress
      })

      // Update ticket
      relatedTicket.status = 'MINTED'
      relatedTicket.tokenId = tokenId
      relatedTicket.tokenUriCid = metadataUri
      relatedTicket.transactionHash = payment_transaction_hash
      relatedTicket.qrCodeData = qrData.qrCodeData
      relatedTicket.qrCodeSecret = qrData.qrCodeSecret
      relatedTicket.expiryTime = expiryTime

      await relatedTicket.save()
      updatedTickets.push(relatedTicket)

      console.log(
        `✅ Updated ticket ${relatedTicket.id} with token ID ${tokenId} and expiry ${expiryTime}`
      )
    }

    // ✅ FIX: Properly update availability
    if (updatedTickets.length > 0) {
      const ticketType = await TicketType.findById(purchase.ticketTypeId)
      if (ticketType) {
        const [soldCount, reservedCount] = await Promise.all([
          Ticket.countDocuments({
            ticketTypeId: purchase.ticketTypeId,
            status: 'MINTED'
          }),
          Ticket.countDocuments({
            ticketTypeId: purchase.ticketTypeId,
            status: { $in: ['PENDING_PAYMENT', 'PAID', 'MINTING'] },
            expiryTime: { $gt: new Date() }
          })
        ])

        const correctAvailability = Math.max(
          0,
          ticketType.totalQuantity - soldCount - reservedCount
        )

        if (ticketType.availableQuantity !== correctAvailability) {
          console.log(
            `🔄 Updating availability: ${ticketType.availableQuantity} -> ${correctAvailability}`
          )

          ticketType.availableQuantity = correctAvailability
          await ticketType.save()

          console.log(
            `✅ TicketType ${ticketType.id} availability updated to ${correctAvailability}`
          )
        }
      }
    }

    console.log(
      `✅ Successfully processed ${updatedTickets.length}/${relatedTickets.length} tickets`
    )

    callback(null, {
      ticket: ticketDocumentToGrpcTicket(updatedTickets[0]),
      tickets: updatedTickets.map(t => ticketDocumentToGrpcTicket(t))
    })
  } catch (error) {
    console.error('❌ ConfirmPaymentAndRequestMint error:', error)

    // ✅ FIX: Better error handling with proper gRPC status codes
    let statusCode = grpc.status.INTERNAL
    let errorMessage =
      error.message || 'Failed to confirm payment and request mint.'

    // Map specific error types to appropriate gRPC status codes
    if (error.message?.includes('Purchase order not found')) {
      statusCode = grpc.status.NOT_FOUND
      errorMessage = 'Purchase order not found'
    } else if (
      error.message?.includes('not confirmed') ||
      error.message?.includes('failed on blockchain')
    ) {
      statusCode = grpc.status.FAILED_PRECONDITION
      errorMessage = 'Transaction not confirmed or failed on blockchain'
    } else if (
      error.message?.includes('Invalid') ||
      error.message?.includes('required')
    ) {
      statusCode = grpc.status.INVALID_ARGUMENT
    } else if (error.message?.includes('Metadata not prepared')) {
      statusCode = grpc.status.FAILED_PRECONDITION
    }

    callback({
      code: statusCode,
      message: errorMessage
    })
  }
}

function createSimpleMetadata (event, ticketType, ticket) {
  const shortEventName =
    event.name.length > 40 ? event.name.substring(0, 40) + '...' : event.name

  // ✅ FIX: Use simpler metadata like old contract
  const metadata = {
    name: `Ticket: ${ticketType.name} - Event: ${shortEventName}`,
    description: `Ticket for event "${shortEventName}". Type: ${ticketType.name}. Session ID (on chain): ${ticketType.contractSessionId}.`,
    image: event.banner_url_cid
      ? `ipfs://${event.banner_url_cid}` // Keep ipfs:// since it worked in old contract
      : `https://via.placeholder.com/400x400/667eea/ffffff?text=Event+Ticket`,
    external_url: `https://yourplatform.com/events/${event.id}`,
    attributes: [
      {
        trait_type: 'Event Name',
        value: shortEventName
      },
      {
        trait_type: 'Ticket Type',
        value: ticketType.name
      },
      {
        trait_type: 'Event Blockchain ID',
        value: ticketType.blockchainEventId || 'unknown'
      },
      {
        trait_type: 'Session On Chain',
        value: ticketType.contractSessionId || 'unknown'
      },
      {
        trait_type: 'Price (WEI)',
        value: ticketType.priceWei
      }
    ]
  }

  // Add seat info if available
  if (ticket.seatInfo) {
    metadata.attributes.push({
      trait_type: 'Seat',
      value: `${String.fromCharCode(65 + parseInt(ticket.seatInfo.row))}${
        parseInt(ticket.seatInfo.seat) + 1
      }`
    })
  }

  console.log('✅ Generated metadata:', {
    name: metadata.name,
    image: metadata.image,
    attributeCount: metadata.attributes.length
  })

  return metadata
}

async function GenerateQRCode (call, callback) {
  const { ticket_id } = call.request

  console.log(`TicketService: GenerateQRCode called for ticket: ${ticket_id}`)

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket ID format.'
      })
    }

    // Tìm ticket
    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found.'
      })
    }

    // ✅ FIX: Allow QR generation for MINTED tickets
    if (ticket.status !== TICKET_STATUS_ENUM[4]) {
      // MINTED
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Cannot generate QR code for ticket with status: ${ticket.status}`
      })
    }

    // ✅ FIX: Get event and session info to set proper expiry time
    let eventData = null
    let sessionEndTime = null

    try {
      const eventResponse = await new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id: ticket.eventId },
          (err, response) => {
            if (err) reject(err)
            else resolve(response)
          }
        )
      })

      eventData = eventResponse.event

      // Find the specific session for this ticket
      if (eventData && eventData.sessions) {
        const ticketSession = eventData.sessions.find(
          s => s.id === ticket.sessionId
        )
        if (ticketSession) {
          sessionEndTime = new Date(ticketSession.end_time * 1000)
          console.log(
            `✅ Found session end time: ${sessionEndTime} for ticket ${ticket_id}`
          )
        } else {
          console.warn(
            `⚠️ Session not found for ticket ${ticket_id}, using first session`
          )
          sessionEndTime = new Date(eventData.sessions[0].end_time * 1000)
        }
      }
    } catch (eventError) {
      console.warn('Could not fetch event data for QR expiry:', eventError)
      sessionEndTime = new Date(Date.now() + 24 * 60 * 60 * 1000)
    }

    // ✅ FIX: Generate QR code if not exists, or regenerate if requested
    let needsUpdate = false

    if (!ticket.qrCodeData || !ticket.qrCodeSecret) {
      const qrData = generateQRCodeData({
        ticketId: ticket.id,
        eventId: ticket.eventId,
        ownerAddress: ticket.ownerAddress
      })

      ticket.qrCodeData = qrData.qrCodeData
      ticket.qrCodeSecret = qrData.qrCodeSecret
      needsUpdate = true
      console.log(`✅ Generated new QR data for ticket ${ticket_id}`)
    }

    // ✅ FIX: Set expiry time based on session end time
    if (!ticket.expiryTime || sessionEndTime) {
      ticket.expiryTime =
        sessionEndTime || new Date(Date.now() + 24 * 60 * 60 * 1000)
      needsUpdate = true
      console.log(`✅ Set ticket expiry time to: ${ticket.expiryTime}`)
    }

    // Save updates if needed
    if (needsUpdate) {
      await ticket.save()
      console.log(`✅ Updated ticket ${ticket_id} with QR code and expiry time`)
    }

    // ✅ FIX: Generate QR code image from the JSON data
    console.log(
      `🔍 Generating QR image for data: ${ticket.qrCodeData.substring(
        0,
        50
      )}...`
    )

    const qrCodeImageDataURL = await generateQRCodeImage(ticket.qrCodeData)

    // ✅ Extract base64 data without the data:image/png;base64, prefix
    const base64ImageData = qrCodeImageDataURL.replace(
      'data:image/png;base64,',
      ''
    )

    console.log(
      `✅ Generated QR image, base64 length: ${base64ImageData.length}`
    )

    callback(null, {
      success: true,
      message: 'QR code generated successfully',
      qr_code_data: ticket.qrCodeData, // JSON data for verification
      qr_code_image_base64: base64ImageData // Pure base64 image data
    })
  } catch (error) {
    console.error('TicketService: GenerateQRCode error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to generate QR code'
    })
  }
}

// ✅ THÊM: Check-in với validation thời gian session
// async function CheckIn (call, callback) {
//   const { qr_code_data, location, scanner_id } = call.request

//   console.log(`TicketService: CheckIn called with scanner: ${scanner_id}`)

//   try {
//     // Parse QR code data
//     let qrData
//     try {
//       qrData = JSON.parse(qr_code_data)
//     } catch (error) {
//       return callback({
//         code: grpc.status.INVALID_ARGUMENT,
//         message: 'Invalid QR code format'
//       })
//     }

//     // Tìm ticket bằng QR code data
//     const ticket = await Ticket.findOne({ qrCodeData: qr_code_data })
//     if (!ticket) {
//       return callback({
//         code: grpc.status.NOT_FOUND,
//         message: 'Ticket not found'
//       })
//     }

//     // Verify QR code signature
//     const verification = verifyQRCodeData(qr_code_data, ticket.qrCodeSecret)
//     if (!verification.valid) {
//       return callback({
//         code: grpc.status.INVALID_ARGUMENT,
//         message: `Invalid QR code: ${verification.reason}`
//       })
//     }

//     console.log(`✅ QR code verified successfully for ticket: ${ticket.id}`)

//     // Kiểm tra ticket status
//     if (ticket.status !== TICKET_STATUS_ENUM[4]) {
//       // MINTED
//       return callback({
//         code: grpc.status.FAILED_PRECONDITION,
//         message: `Cannot check-in ticket with status: ${ticket.status}`
//       })
//     }

//     // ✅ FIX: Lấy thông tin event và session để validate thời gian
//     let eventData = null
//     try {
//       const eventResponse = await new Promise((resolve, reject) => {
//         eventServiceClient.GetEvent(
//           { event_id: ticket.eventId },
//           (err, response) => {
//             if (err) reject(err)
//             else resolve(response)
//           }
//         )
//       })
//       eventData = eventResponse.event
//     } catch (eventError) {
//       console.warn(
//         'Could not fetch event data for check-in validation:',
//         eventError
//       )
//       return callback({
//         code: grpc.status.INTERNAL,
//         message: 'Cannot validate event details for check-in'
//       })
//     }

//     // ✅ FIX: Validate check-in timing dựa trên session
//     const now = Date.now()
//     let relevantSession = null

//     if (eventData && eventData.sessions && eventData.sessions.length > 0) {
//       // Find the specific session for this ticket
//       if (ticket.sessionId) {
//         relevantSession = eventData.sessions.find(
//           s => s.id === ticket.sessionId
//         )
//       }

//       // Fallback to earliest session if specific session not found
//       if (!relevantSession) {
//         relevantSession = eventData.sessions.reduce((earliest, current) =>
//           current.start_time < earliest.start_time ? current : earliest
//         )
//       }

//       if (relevantSession) {
//         const sessionStartTime =
//           relevantSession.start_time < 10000000000
//             ? relevantSession.start_time * 1000
//             : relevantSession.start_time

//         const sessionEndTime =
//           relevantSession.end_time < 10000000000
//             ? relevantSession.end_time * 1000
//             : relevantSession.end_time

//         // ✅ FIX: Check-in window validation
//         const checkInWindowStart = sessionStartTime - 2 * 60 * 60 * 1000 // 2 giờ trước event
//         const checkInWindowEnd = sessionEndTime // Đến khi event kết thúc

//         console.log('🔍 Check-in timing validation:', {
//           now: new Date(now).toISOString(),
//           sessionStart: new Date(sessionStartTime).toISOString(),
//           sessionEnd: new Date(sessionEndTime).toISOString(),
//           checkInWindowStart: new Date(checkInWindowStart).toISOString(),
//           checkInWindowEnd: new Date(checkInWindowEnd).toISOString(),
//           canCheckIn: now >= checkInWindowStart && now <= checkInWindowEnd
//         })

//         // Kiểm tra xem có trong thời gian cho phép check-in không
//         if (now < checkInWindowStart) {
//           return callback({
//             code: grpc.status.FAILED_PRECONDITION,
//             message: `Check-in chưa mở. Bạn có thể check-in từ ${new Date(
//               checkInWindowStart
//             ).toLocaleString('vi-VN')}`
//           })
//         }

//         if (now > checkInWindowEnd) {
//           return callback({
//             code: grpc.status.FAILED_PRECONDITION,
//             message: `Sự kiện đã kết thúc. Không thể check-in sau ${new Date(
//               checkInWindowEnd
//             ).toLocaleString('vi-VN')}`
//           })
//         }
//       }
//     }

//     // Kiểm tra expiry time của ticket
//     if (ticket.expiryTime && new Date() > ticket.expiryTime) {
//       return callback({
//         code: grpc.status.FAILED_PRECONDITION,
//         message: 'Ticket has expired'
//       })
//     }

//     // Kiểm tra đã check-in chưa
//     if (ticket.checkInStatus === 'CHECKED_IN') {
//       return callback({
//         code: grpc.status.ALREADY_EXISTS,
//         message: `Ticket already checked in at ${
//           ticket.checkInTime
//             ? new Date(ticket.checkInTime).toLocaleString('vi-VN')
//             : 'unknown time'
//         }`
//       })
//     }

//     // ✅ FIX: Thực hiện check-in với session info
//     ticket.checkInStatus = 'CHECKED_IN'
//     ticket.checkInTime = new Date()
//     ticket.checkInLocation = location || 'Unknown'

//     await ticket.save()

//     console.log(
//       `✅ Ticket ${ticket.id} checked in successfully at ${ticket.checkInTime}`
//     )

//     // ✅ FIX: Return detailed response
//     callback(null, {
//       success: true,
//       message: 'Check-in thành công',
//       ticket: ticketDocumentToGrpcTicket(ticket),
//       session_info: relevantSession
//         ? {
//             session_name: relevantSession.name,
//             session_start: relevantSession.start_time,
//             session_end: relevantSession.end_time
//           }
//         : null
//     })
//   } catch (error) {
//     console.error('TicketService: CheckIn error:', error)
//     callback({
//       code: grpc.status.INTERNAL,
//       message: error.message || 'Check-in failed'
//     })
//   }
// }

async function CheckIn (call, callback) {
  const { qr_code_data, location, scanner_id } = call.request

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
        message: 'Ticket not found'
      })
    }

    // Verify QR code signature
    const verification = verifyQRCodeData(qr_code_data, ticket.qrCodeSecret)
    if (!verification.valid) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid QR code: ${verification.reason}`
      })
    }

    // ✅ NEW: Verify blockchain ownership
    if (ticket.tokenId && ticket.tokenId !== '0') {
      console.log(
        `🔍 Verifying blockchain ownership for token ${ticket.tokenId}`
      )

      try {
        const ownershipResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.VerifyTokenOwnership(
            {
              token_id: ticket.tokenId,
              expected_owner: ticket.ownerAddress
            },
            (err, res) => {
              if (err) reject(err)
              else resolve(res)
            }
          )
        })

        if (!ownershipResponse.is_valid_owner) {
          console.error(`❌ Ownership verification failed:`, {
            tokenId: ticket.tokenId,
            expectedOwner: ticket.ownerAddress,
            actualOwner: ownershipResponse.actual_owner,
            reason: ownershipResponse.reason
          })

          return callback({
            code: grpc.status.FAILED_PRECONDITION,
            message: `Ownership verification failed: ${
              ownershipResponse.reason || 'Token owner mismatch'
            }`
          })
        }

        console.log(
          `✅ Blockchain ownership verified for token ${ticket.tokenId}`
        )
      } catch (blockchainError) {
        console.error('❌ Blockchain ownership check failed:', blockchainError)
        return callback({
          code: grpc.status.INTERNAL,
          message: 'Failed to verify token ownership on blockchain'
        })
      }
    } else {
      console.warn(
        `⚠️ Ticket ${ticket.id} has no tokenId, skipping blockchain verification`
      )
    }

    // Rest of existing check-in logic...
    if (ticket.status !== TICKET_STATUS_ENUM[4]) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Cannot check-in ticket with status: ${ticket.status}`
      })
    }

    if (ticket.checkInStatus === 'CHECKED_IN') {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `Ticket already checked in`
      })
    }

    // Perform check-in
    ticket.checkInStatus = 'CHECKED_IN'
    ticket.checkInTime = new Date()
    ticket.checkInLocation = location || 'Unknown'
    await ticket.save()

    callback(null, {
      success: true,
      message: 'Check-in successful with blockchain verification',
      ticket: ticketDocumentToGrpcTicket(ticket)
    })
  } catch (error) {
    console.error('CheckIn error:', error)
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
    console.log(
      `TicketService: GetTicketMetadata called for ticket: ${ticket_id}`
    )

    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found.'
      })
    }

    if (!ticket.tokenUriCid) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket metadata not yet generated.'
      })
    }

    // Convert IPFS URI to HTTP gateway URL for easier access
    const metadataUrl = ticket.tokenUriCid.replace(
      'ipfs://',
      'https://gateway.pinata.cloud/ipfs/'
    )

    callback(null, {
      metadata: JSON.stringify({
        ticket_id: ticket.id,
        token_uri_cid: ticket.tokenUriCid,
        metadata_url: metadataUrl,
        token_id: ticket.tokenId,
        status: ticket.status,
        owner_address: ticket.ownerAddress
      })
    })
  } catch (error) {
    console.error('TicketService: GetTicketMetadata error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get ticket metadata.'
    })
  }
}

async function PrepareMetadata (call, callback) {
  const { ticket_order_id, quantity, selected_seats } = call.request
  console.log(
    `TicketService: PrepareMetadata called for order: ${ticket_order_id}, quantity: ${quantity}`
  )

  try {
    // Find purchase record
    const purchase = await Purchase.findOne({ purchaseId: ticket_order_id })
    if (!purchase) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Purchase order not found.'
      })
    }

    if (purchase.status !== 'INITIATED') {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Purchase order is in ${purchase.status} status, cannot prepare metadata.`
      })
    }

    // Get ticket type and event data
    const [ticketTypeData, eventResponse] = await Promise.all([
      TicketType.findById(purchase.ticketTypeId),
      new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id: purchase.purchaseDetails.event_id },
          { deadline: new Date(Date.now() + 10000) },
          (err, res) => {
            if (err) reject(err)
            else resolve(res)
          }
        )
      })
    ])

    if (!ticketTypeData || !eventResponse?.event) {
      throw new Error('Failed to get event or ticket type data')
    }

    const metadataUris = []

    // Generate metadata for each ticket
    for (let i = 0; i < quantity; i++) {
      // Create temporary ticket object for metadata generation
      const tempTicket = {
        id: `temp_${ticket_order_id}_${i}`,
        eventId: purchase.purchaseDetails.event_id,
        ticketTypeId: purchase.ticketTypeId,
        ownerAddress: purchase.walletAddress
      }

      // Add seat info if available
      if (selected_seats && selected_seats.length > i) {
        const seatKey = selected_seats[i]
        const [section, row, seat] = seatKey.split('-')
        tempTicket.seatInfo = {
          seatKey: seatKey,
          section: section,
          row: row,
          seat: seat
        }
      }

      // Create metadata
      const metadata = createSimpleMetadata(
        eventResponse.event,
        ticketTypeData,
        tempTicket
      )

      // Upload metadata to IPFS
      const ipfsResponse = await new Promise((resolve, reject) => {
        ipfsServiceClient.PinJSONToIPFS(
          {
            json_content: JSON.stringify(metadata),
            options: {
              pin_name: `ticket-metadata-${ticket_order_id}-${i}`
            }
          },
          { deadline: new Date(Date.now() + 30000) },
          (err, res) => {
            if (err) reject(err)
            else resolve(res)
          }
        )
      })

      const metadataCid = ipfsResponse.ipfs_hash
      const fullTokenUri = `ipfs://${metadataCid}`
      metadataUris.push(fullTokenUri)

      console.log(`✅ Generated metadata ${i + 1}/${quantity}: ${fullTokenUri}`)
    }

    // Store metadata URIs in purchase record for later reference
    purchase.metadataUris = metadataUris
    await purchase.save()

    console.log(`✅ All metadata prepared for order: ${ticket_order_id}`)

    callback(null, {
      success: true,
      metadata_uris: metadataUris
    })
  } catch (error) {
    console.error('PrepareMetadata error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to prepare metadata.'
    })
  }
}

async function GetMyTicketsWithDetails (call, callback) {
  try {
    const { owner_address } = call.request

    if (!owner_address) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Owner address is required'
      })
    }

    console.log(`🔍 Fetching tickets with details for: ${owner_address}`)

    // Find all tickets for this owner
    const tickets = await Ticket.find({
      ownerAddress: owner_address.toLowerCase(),
      status: 'MINTED'
    }).sort({ createdAt: -1 })

    if (tickets.length === 0) {
      return callback(null, { tickets: [] })
    }

    // Get unique eventIds and ticketTypeIds
    const eventIds = [...new Set(tickets.map(t => t.eventId))]
    const ticketTypeIds = [...new Set(tickets.map(t => t.ticketTypeId))]

    // Batch fetch events and ticket types
    const [eventResponses, ticketTypeResponses] = await Promise.all([
      Promise.all(
        eventIds.map(
          eventId =>
            new Promise((resolve, reject) => {
              eventServiceClient.GetEvent({ event_id: eventId }, (err, res) => {
                if (err) {
                  console.warn(`Event ${eventId} not found:`, err.message)
                  resolve({ event_id: eventId, event: null })
                } else {
                  resolve({ event_id: eventId, event: res.event })
                }
              })
            })
        )
      ),
      Promise.all(
        ticketTypeIds.map(typeId =>
          TicketType.findById(typeId).catch(err => {
            console.warn(`TicketType ${typeId} not found:`, err.message)
            return null
          })
        )
      )
    ])

    // Create lookup maps
    const eventsMap = {}
    eventResponses.forEach(response => {
      if (response.event) {
        eventsMap[response.event_id] = response.event
      }
    })

    const ticketTypesMap = {}
    ticketTypeResponses.forEach((type, index) => {
      if (type) {
        ticketTypesMap[ticketTypeIds[index]] = type
      }
    })

    // Transform tickets with full details
    const detailedTickets = await Promise.all(
      tickets.map(async ticket => {
        const event = eventsMap[ticket.eventId]
        const ticketType = ticketTypesMap[ticket.ticketTypeId]

        // ✅ FIX: Handle QR code properly
        let qrCodeData = null
        if (ticket.qrCodeData) {
          // ✅ Don't generate image here, just return the JSON data
          // Frontend will handle the image generation
          qrCodeData = ticket.qrCodeData
          console.log(
            `🔍 Ticket ${ticket.id} has QR data: ${qrCodeData.substring(
              0,
              50
            )}...`
          )
        } else {
          console.log(`⚠️ Ticket ${ticket.id} has no QR data`)
        }

        return {
          id: ticket.id,
          event_id: ticket.eventId,
          ticket_type_id: ticket.ticketTypeId,
          token_id: ticket.tokenId || '',
          owner_address: ticket.ownerAddress,
          session_id: ticket.sessionId,
          status: ticket.status,
          created_at: Math.floor(ticket.createdAt.getTime() / 1000),
          check_in_status: ticket.checkInStatus,
          check_in_time: ticket.checkInTime
            ? Math.floor(ticket.checkInTime.getTime() / 1000)
            : 0,
          expiry_time: ticket.expiryTime
            ? Math.floor(ticket.expiryTime.getTime() / 1000)
            : 0,
          seat_info: ticket.seatInfo || null,
          qr_code_data: qrCodeData, // ✅ This is the JSON string, not base64 image
          event: event || null,
          ticket_type: ticketType
            ? {
                id: ticketType.id,
                name: ticketType.name,
                price_wei: ticketType.priceWei
              }
            : null
        }
      })
    )

    callback(null, { tickets: detailedTickets })
  } catch (error) {
    console.error('GetMyTicketsWithDetails error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get tickets with details'
    })
  }
}

module.exports = {
  InitiatePurchase,
  ConfirmPaymentAndRequestMint,
  PrepareMetadata,
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
  GetPurchaseAnalytics,
  GetSoldSeatsByEvent,
  GetMyTicketsWithDetails
}
