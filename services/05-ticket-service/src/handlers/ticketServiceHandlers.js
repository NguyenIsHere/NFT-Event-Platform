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
        message: `Purchase order is in ${purchase.status} status, cannot confirm.`
      })
    }

    // Find related pending tickets
    const relatedTickets = await Ticket.find({
      ownerAddress: purchase.walletAddress.toLowerCase(),
      ticketTypeId: purchase.ticketTypeId,
      status: 'PENDING_PAYMENT',
      createdAt: {
        $gte: new Date(purchase.createdAt.getTime() - 5 * 60 * 1000),
        $lte: new Date(purchase.createdAt.getTime() + 5 * 60 * 1000)
      }
    })

    if (relatedTickets.length === 0) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No pending tickets found for this purchase.'
      })
    }

    console.log(`🎫 Found ${relatedTickets.length} tickets to process`)

    // Update purchase status first
    purchase.status = 'CONFIRMED'
    purchase.transactionHash = payment_transaction_hash
    await purchase.save()

    // Process each ticket
    const updatedTickets = []
    for (const ticket of relatedTickets) {
      try {
        // Get event and ticket type data for metadata
        const [eventResponse, ticketTypeData] = await Promise.all([
          new Promise((resolve, reject) => {
            eventServiceClient.GetEvent(
              { event_id: ticket.eventId },
              { deadline: new Date(Date.now() + 10000) },
              (err, res) => {
                if (err) reject(err)
                else resolve(res)
              }
            )
          }),
          TicketType.findById(ticket.ticketTypeId)
        ])

        if (!eventResponse?.event || !ticketTypeData) {
          throw new Error('Failed to get event or ticket type data')
        }

        // Create metadata
        const metadata = createSimpleMetadata(
          eventResponse.event,
          ticketTypeData,
          ticket
        )

        // Upload metadata to IPFS
        const ipfsResponse = await new Promise((resolve, reject) => {
          ipfsServiceClient.PinJSONToIPFS(
            {
              json_content: JSON.stringify(metadata),
              options: {
                pin_name: `ticket-metadata-${ticket.id}`
              }
            },
            { deadline: new Date(Date.now() + 30000) },
            (err, res) => {
              if (err) reject(err)
              else resolve(res)
            }
          )
        })

        // Mint on blockchain
        const mintResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.MintTicket(
            {
              buyer_address: ticket.ownerAddress,
              token_uri_cid: `ipfs://${ipfsResponse.ipfs_hash}`,
              blockchain_ticket_type_id: ticketTypeData.blockchainTicketTypeId,
              session_id_for_contract: ticketTypeData.contractSessionId
            },
            { deadline: new Date(Date.now() + 60000) },
            (err, res) => {
              if (err) reject(err)
              else resolve(res)
            }
          )
        })

        if (!mintResponse.success) {
          throw new Error('Blockchain mint failed')
        }

        // Generate QR code
        // ✅ FIX: Generate QR code properly - destructure the returned object
        const qrCodeResult = generateQRCodeData(ticket.id, ticket.ownerAddress)

        // Check if generateQRCodeData returns an object or direct values
        let qrCodeDataString, qrCodeSecret

        if (typeof qrCodeResult === 'object' && qrCodeResult.qrCodeData) {
          // If it returns an object with qrCodeData and qrCodeSecret
          qrCodeDataString = qrCodeResult.qrCodeData
          qrCodeSecret = qrCodeResult.qrCodeSecret
        } else if (typeof qrCodeResult === 'string') {
          // If it returns just the QR code data string
          qrCodeDataString = qrCodeResult
          qrCodeSecret = null // Will need to generate separately if needed
        } else {
          throw new Error('Invalid QR code generation result')
        }

        // Update ticket
        ticket.status = 'MINTED'
        ticket.tokenId = mintResponse.token_id
        ticket.tokenUriCid = ipfsResponse.ipfs_hash
        ticket.transactionHash = mintResponse.transaction_hash
        ticket.qrCodeData = qrCodeDataString
        ticket.checkInStatus = 'NOT_CHECKED_IN'

        // ✅ FIX: Only set qrCodeSecret if we have it
        if (qrCodeSecret) {
          ticket.qrCodeSecret = qrCodeSecret
        }

        await ticket.save()
        updatedTickets.push(ticket)

        console.log(
          `✅ Successfully processed ticket ${ticket.id}, tokenId: ${mintResponse.token_id}`
        )
      } catch (ticketError) {
        console.error(`❌ Error processing ticket ${ticket.id}:`, ticketError)
        // Mark ticket as failed
        ticket.status = 'MINT_FAILED'
        await ticket.save()
      }
    }

    // ✅ FIX: Properly update availability - CRITICAL FIX
    if (updatedTickets.length > 0) {
      const ticketType = await TicketType.findById(purchase.ticketTypeId)
      if (ticketType) {
        // Calculate REAL availability from database state
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

        // Only update if different
        if (ticketType.availableQuantity !== correctAvailability) {
          console.log(
            `🔄 Updating availability: ${ticketType.availableQuantity} -> ${correctAvailability}`
          )

          ticketType.availableQuantity = correctAvailability
          await ticketType.save()

          console.log(
            `✅ TicketType ${ticketType.id} availability updated to ${correctAvailability}`
          )
        } else {
          console.log(
            `✅ TicketType availability already correct: ${correctAvailability}`
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
    console.error('ConfirmPaymentAndRequestMint error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to confirm payment and request mint.'
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
        message: 'Invalid ticket ID format'
      })
    }

    // Tìm ticket
    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket not found'
      })
    }

    // ✅ FIX: Allow QR generation for MINTED tickets
    if (ticket.status !== TICKET_STATUS_ENUM[4]) {
      // MINTED
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Cannot generate QR code for ticket with status: ${ticket.status}. Ticket must be MINTED.`
      })
    }

    // ✅ FIX: Generate QR code if not exists, or regenerate if requested
    let needsUpdate = false

    if (!ticket.qrCodeData || !ticket.qrCodeSecret) {
      console.log(`🔄 Generating new QR code for ticket ${ticket.id}...`)

      const { qrCodeData, qrCodeSecret } = generateQRCodeData({
        ticketId: ticket.id,
        eventId: ticket.eventId,
        ownerAddress: ticket.ownerAddress
      })

      ticket.qrCodeData = qrCodeData
      ticket.qrCodeSecret = qrCodeSecret
      needsUpdate = true
    }

    // ✅ FIX: Set expiry time if not set
    if (!ticket.expiryTime) {
      try {
        const ticketType = await TicketType.findById(ticket.ticketTypeId)
        if (ticketType) {
          const eventResponse = await new Promise((resolve, reject) => {
            eventServiceClient.GetEvent(
              {
                event_id: ticketType.eventId
              },
              { deadline: new Date(Date.now() + 5000) },
              (err, res) => {
                if (err) reject(err)
                else resolve(res)
              }
            )
          })

          if (eventResponse?.event?.sessions) {
            const targetSession = eventResponse.event.sessions.find(
              s => s.id === ticketType.sessionId
            )
            if (targetSession) {
              // Set expiry to 24 hours after event end time
              const eventEndTime = new Date(targetSession.end_time * 1000)
              ticket.expiryTime = new Date(
                eventEndTime.getTime() + 24 * 60 * 60 * 1000
              )
              needsUpdate = true
            }
          }
        }
      } catch (expiryError) {
        console.warn('⚠️ Could not set ticket expiry time:', expiryError)
        // Set default expiry to 30 days from now
        ticket.expiryTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        needsUpdate = true
      }
    }

    // Save updates if needed
    if (needsUpdate) {
      await ticket.save()
      console.log(`✅ Ticket ${ticket.id} updated with QR code and expiry`)
    }

    // ✅ FIX: Generate QR code image
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
