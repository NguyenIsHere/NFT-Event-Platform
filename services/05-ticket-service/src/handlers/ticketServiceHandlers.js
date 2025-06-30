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

const {
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics,
  GetAdminAnalytics, // ✅ NEW
  GetOrganizerAnalytics // ✅ NEW
} = require('./analyticsHandlers')
const ethers = require('ethers')
const TransactionLogger = require('../utils/transactionLogger')

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

  try {
    // ✅ VALIDATE inputs (giữ nguyên validation logic)
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket type ID format.'
      })
    }

    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket type not found.'
      })
    }

    // ✅ CHECK availability (real-time từ Ticket collection)
    const soldTicketsCount = await Ticket.countDocuments({
      ticketTypeId: ticket_type_id,
      status: { $in: ['PAID', 'MINTING', 'MINTED'] }
    })

    const availableQuantity = ticketType.totalQuantity - soldTicketsCount

    if (availableQuantity < quantity) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Not enough tickets available. Only ${availableQuantity} left.`
      })
    }

    // ✅ GENERATE unique order ID
    const ticketOrderId = `${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`

    // ✅ GET payment details từ blockchain service
    const paymentDetails = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetTicketPaymentDetails(
        {
          blockchain_event_id: ticketType.blockchainEventId,
          price_wei_from_ticket_type: ticketType.priceWei
        },
        (err, res) => {
          if (err) reject(err)
          else resolve(res)
        }
      )
    })

    // ✅ CREATE PENDING tickets trực tiếp (không cần Purchase)
    const ticketsToCreate = []

    for (let i = 0; i < quantity; i++) {
      const ticketData = {
        eventId: ticketType.eventId,
        ticketTypeId: ticket_type_id,
        ownerAddress: buyer_address.toLowerCase(),
        sessionId: ticketType.sessionId,
        status: TICKET_STATUS_ENUM[0], // PENDING_PAYMENT
        // ✅ ADD: Store order info trong metadata
        metadata: {
          ticketOrderId,
          orderIndex: i,
          totalQuantity: quantity
        }
      }

      // ✅ ADD seat info if provided
      if (selected_seats && selected_seats[i]) {
        const seatKey = selected_seats[i]
        const [section, row, seat] = seatKey.split('-')
        ticketData.seatInfo = {
          seatKey,
          section,
          row,
          seat
        }
      }

      ticketsToCreate.push(ticketData)
    }

    // ✅ SAVE pending tickets
    const savedTickets = await Ticket.insertMany(ticketsToCreate)

    // ✅ LOG: Initial purchase transaction (INITIATED)
    await TransactionLogger.logTicketPurchase({
      transactionHash: '', // Chưa có transaction hash
      eventId: ticketType.eventId,
      organizerId: null, // Sẽ được fill sau
      userId: null,
      ticketTypeId: ticket_type_id,
      fromAddress: buyer_address,
      toAddress: paymentDetails.payment_contract_address,
      amountWei: (parseFloat(ticketType.priceWei) * quantity).toString(),
      platformFeeWei: '0', // Sẽ được tính từ contract
      organizerAmountWei: '0', // Sẽ được tính từ contract
      feePercentAtTime: 0, // Sẽ được lấy từ contract
      purchaseId: ticketOrderId, // ✅ CHANGE: Dùng ticket order ID
      ticketIds: savedTickets.map(t => t.id),
      quantity
    })

    callback(null, {
      ticket_order_id: ticketOrderId,
      payment_contract_address: paymentDetails.payment_contract_address,
      price_to_pay_wei: (parseFloat(ticketType.priceWei) * quantity).toString(),
      blockchain_event_id: ticketType.blockchainEventId,
      blockchain_ticket_type_id: ticketType.blockchainTicketTypeId,
      session_id_for_contract: ticketType.contractSessionId,
      purchase_id: ticketOrderId // ✅ DEPRECATED: Để backward compatibility
    })
  } catch (error) {
    console.error('❌ InitiatePurchase error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to initiate purchase'
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

async function PrepareMetadata (call, callback) {
  const { ticket_order_id, quantity, selected_seats } = call.request
  console.log(
    `TicketService: PrepareMetadata called for order: ${ticket_order_id}, quantity: ${quantity}`
  )

  try {
    // ✅ FIND pending tickets by order ID (thay vì Purchase)
    const pendingTickets = await Ticket.find({
      'metadata.ticketOrderId': ticket_order_id,
      status: TICKET_STATUS_ENUM[0] // PENDING_PAYMENT
    }).sort({ 'metadata.orderIndex': 1 })

    if (!pendingTickets || pendingTickets.length === 0) {
      console.error(`❌ No pending tickets found for order: ${ticket_order_id}`)
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No pending tickets found for this order.'
      })
    }

    console.log(`✅ Found ${pendingTickets.length} pending tickets`)

    const firstTicket = pendingTickets[0]

    // ✅ GET ticket type and event data from first ticket
    const [ticketTypeData, eventResponse] = await Promise.all([
      TicketType.findById(firstTicket.ticketTypeId),
      new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id: firstTicket.eventId },
          { deadline: new Date(Date.now() + 10000) },
          (err, res) => {
            if (err) {
              console.error('❌ Error getting event:', err)
              reject(err)
            } else {
              console.log('✅ Got event data:', res.event?.name)
              resolve(res)
            }
          }
        )
      })
    ])

    if (!ticketTypeData || !eventResponse?.event) {
      console.error('❌ Missing ticket type or event data:', {
        hasTicketType: !!ticketTypeData,
        hasEvent: !!eventResponse?.event
      })
      throw new Error('Failed to get event or ticket type data')
    }

    console.log(
      `✅ Got ticket type: ${ticketTypeData.name} and event: ${eventResponse.event.name}`
    )

    const metadataUris = []

    // Generate metadata for each ticket
    for (let i = 0; i < pendingTickets.length; i++) {
      const ticket = pendingTickets[i]

      console.log(`🔍 Processing ticket ${i + 1}/${pendingTickets.length}`)

      // Create metadata using existing ticket data
      const metadata = createSimpleMetadata(
        eventResponse.event,
        ticketTypeData,
        ticket
      )

      console.log(`📋 Generated metadata for ticket ${i + 1}:`, {
        name: metadata.name,
        attributeCount: metadata.attributes?.length
      })

      // ✅ FIX: Upload metadata to IPFS with better error handling
      try {
        console.log(`📤 Uploading metadata ${i + 1} to IPFS...`)

        const ipfsResponse = await new Promise((resolve, reject) => {
          // ✅ FIX: Use correct IPFS service method
          ipfsServiceClient.PinJSONToIPFS(
            {
              json_content: JSON.stringify(metadata), // ✅ Correct field name
              options: {
                pin_name: `ticket-metadata-${ticket_order_id}-${i + 1}`
              }
            },
            { deadline: new Date(Date.now() + 30000) },
            (err, res) => {
              if (err) {
                console.error(`❌ IPFS error for ticket ${i + 1}:`, {
                  error: err.message,
                  code: err.code,
                  details: err.details
                })
                reject(err)
              } else {
                console.log(`✅ IPFS success for ticket ${i + 1}:`, {
                  hash: res.ipfs_hash,
                  size: res.pin_size_bytes
                })
                resolve(res)
              }
            }
          )
        })

        const metadataCid = ipfsResponse.ipfs_hash
        const fullTokenUri = `ipfs://${metadataCid}`
        metadataUris.push(fullTokenUri)

        // ✅ UPDATE ticket with metadata URI
        ticket.tokenUriCid = fullTokenUri
        await ticket.save()

        console.log(`✅ Ticket ${i + 1} metadata URI: ${fullTokenUri}`)
      } catch (ipfsError) {
        console.error(`❌ IPFS upload failed for ticket ${i + 1}:`, {
          error: ipfsError.message,
          ticketId: ticket.id
        })
        throw new Error(
          `IPFS upload failed for ticket ${i + 1}: ${ipfsError.message}`
        )
      }
    }

    console.log(`✅ All metadata prepared for order: ${ticket_order_id}`)
    console.log(`📋 Generated URIs:`, metadataUris)

    callback(null, {
      success: true,
      metadata_uris: metadataUris
    })
  } catch (error) {
    console.error('❌ PrepareMetadata error:', {
      error: error.message,
      stack: error.stack,
      ticketOrderId: ticket_order_id
    })

    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to prepare metadata.'
    })
  }
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

async function ConfirmPaymentAndRequestMint (call, callback) {
  const { ticket_order_id, payment_transaction_hash } = call.request

  try {
    console.log('🔄 ConfirmPaymentAndRequestMint called:', {
      ticket_order_id,
      payment_transaction_hash
    })

    // ✅ FIND pending tickets by order ID (thay vì Purchase)
    const pendingTickets = await Ticket.find({
      'metadata.ticketOrderId': ticket_order_id,
      status: TICKET_STATUS_ENUM[0] // PENDING_PAYMENT
    }).sort({ 'metadata.orderIndex': 1 })

    if (!pendingTickets || pendingTickets.length === 0) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `No pending tickets found for order: ${ticket_order_id}`
      })
    }

    console.log(
      `✅ Found ${pendingTickets.length} pending tickets for order: ${ticket_order_id}`
    )

    const firstTicket = pendingTickets[0]
    const ticketType = await TicketType.findById(firstTicket.ticketTypeId)

    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'Ticket type not found'
      })
    }

    console.log('🔍 Processing order for ticket type:', {
      ticketTypeId: ticketType.id,
      name: ticketType.name,
      priceWei: ticketType.priceWei,
      eventId: ticketType.eventId
    })

    // ✅ VERIFY blockchain transaction để get gas info
    let transactionDetails = null
    let gasUsed = null
    let gasPriceWei = null

    const verifyResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.VerifyTransaction(
        { transaction_hash: payment_transaction_hash },
        (err, res) => {
          if (err) reject(err)
          else resolve(res)
        }
      )
    })

    if (verifyResponse.is_confirmed && verifyResponse.success_on_chain) {
      transactionDetails = verifyResponse
      // ✅ TODO: Extract gas info từ blockchain service nếu available
      gasUsed = verifyResponse.gas_used
      gasPriceWei = verifyResponse.gas_price_wei
    } else {
      console.log('verify failed')
    }

    console.log('✅ Transaction verified successfully:', {
      blockNumber: verifyResponse.block_number,
      valueWei: verifyResponse.value_wei,
      from: verifyResponse.from_address,
      to: verifyResponse.to_address
    })

    // ✅ GET current platform fee từ contract
    const feeResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.GetPlatformFee({}, (err, res) => {
        if (err) reject(err)
        else resolve(res)
      })
    })

    const currentPlatformFeePercent = feeResponse.fee_percent || 10

    // ✅ CALCULATE fees từ verified amount
    const totalPaidWei = parseFloat(verifyResponse.value_wei || '0')
    const platformFeeWei = Math.floor(
      (totalPaidWei * currentPlatformFeePercent) / 100
    )
    const organizerAmountWei = totalPaidWei - platformFeeWei

    console.log('💰 Fee calculation:', {
      totalPaidWei,
      currentPlatformFeePercent,
      platformFeeWei,
      organizerAmountWei
    })

    // ✅ UPDATE tickets to PAID
    await Ticket.updateMany(
      { 'metadata.ticketOrderId': ticket_order_id },
      {
        status: TICKET_STATUS_ENUM[1], // PAID
        transactionHash: payment_transaction_hash
      }
    )

    console.log(`✅ Updated ${pendingTickets.length} tickets to PAID status`)

    // ✅ GET parent event for organizer info
    let parentEvent = null
    try {
      const eventResponse = await new Promise((resolve, reject) => {
        eventServiceClient.GetEvent(
          { event_id: ticketType.eventId },
          { deadline: new Date(Date.now() + 10000) },
          (err, res) => {
            if (err) reject(err)
            else resolve(res)
          }
        )
      })
      parentEvent = eventResponse.event
    } catch (eventError) {
      console.warn('Could not fetch parent event:', eventError)
    }

    // ✅ LOG: Confirmed purchase transaction
    await TransactionLogger.logTicketPurchase({
      transactionHash: payment_transaction_hash,
      blockNumber: verifyResponse.block_number,
      gasUsed,
      gasPriceWei,
      eventId: firstTicket.eventId,
      organizerId: parentEvent?.organizer_id || null,
      userId: null,
      ticketTypeId: firstTicket.ticketTypeId,
      fromAddress: verifyResponse.from_address,
      toAddress: verifyResponse.to_address,
      amountWei: totalPaidWei.toString(),
      platformFeeWei: platformFeeWei.toString(),
      organizerAmountWei: organizerAmountWei.toString(),
      feePercentAtTime: currentPlatformFeePercent,
      purchaseId: ticket_order_id,
      ticketIds: pendingTickets.map(t => t.id),
      quantity: pendingTickets.length,
      paymentMethod: 'WALLET' // ✅ Default to wallet for now
    })

    console.log('✅ Transaction logged successfully')

    // ✅ PROCEED with minting process
    console.log('🎭 Starting minting process...')

    const updatedTickets = []

    for (let i = 0; i < pendingTickets.length; i++) {
      const ticket = pendingTickets[i]

      try {
        // ✅ SET status to MINTING
        ticket.status = TICKET_STATUS_ENUM[2] // MINTING
        await ticket.save()

        // ✅ CREATE metadata for this ticket
        const metadata = createSimpleMetadata(parentEvent, ticketType, ticket)

        // ✅ VALIDATE metadata before sending to IPFS
        if (!metadata || typeof metadata !== 'object') {
          throw new Error(`Invalid metadata generated for ticket ${i + 1}`)
        }

        console.log(`📋 Generated metadata for ticket ${i + 1}:`, {
          name: metadata.name,
          image: metadata.image,
          attributeCount: metadata.attributes?.length || 0,
          hasDescription: !!metadata.description
        })

        // ✅ UPLOAD metadata to IPFS
        const metadataString = JSON.stringify(metadata)

        if (
          !metadataString ||
          metadataString === '{}' ||
          metadataString.length < 10
        ) {
          throw new Error(
            `Generated metadata is empty or invalid for ticket ${i + 1}`
          )
        }

        console.log(
          `📤 Uploading metadata ${i + 1} to IPFS (${
            metadataString.length
          } chars)...`
        )

        // ✅ UPLOAD metadata to IPFS
        const ipfsResponse = await new Promise((resolve, reject) => {
          ipfsServiceClient.PinJSONToIPFS(
            {
              json_content: metadataString,
              options: {
                pin_name: `ticket-mint-metadata-${ticket_order_id}-${i + 1}`
              }
            },
            { deadline: new Date(Date.now() + 15000) },
            (err, res) => {
              if (err) {
                console.error(`❌ IPFS error for ticket ${i + 1}:`, {
                  error: err.message,
                  code: err.code,
                  metadataLength: metadataString.length,
                  metadataPreview: metadataString.substring(0, 200)
                })
                reject(err)
              } else {
                console.log(`✅ IPFS success for ticket ${i + 1}:`, {
                  hash: res.ipfs_hash,
                  size: res.pin_size_bytes
                })
                resolve(res)
              }
            }
          )
        })

        const metadataCid = ipfsResponse.ipfs_hash
        const fullTokenUri = `ipfs://${metadataCid}`

        console.log(`📁 Metadata uploaded for ticket ${i + 1}:`, {
          cid: metadataCid,
          uri: fullTokenUri
        })

        // ✅ MINT NFT on blockchain
        const mintResponse = await new Promise((resolve, reject) => {
          blockchainServiceClient.MintTicket(
            {
              buyer_address: ticket.ownerAddress,
              token_uri_cid: fullTokenUri,
              blockchain_ticket_type_id: ticketType.blockchainTicketTypeId,
              session_id_for_contract: ticketType.contractSessionId
            },
            { deadline: new Date(Date.now() + 30000) },
            (err, res) => {
              if (err) reject(err)
              else resolve(res)
            }
          )
        })

        if (mintResponse.success) {
          // ✅ UPDATE ticket with mint info
          ticket.status = TICKET_STATUS_ENUM[4] // MINTED
          ticket.tokenId = mintResponse.token_id
          ticket.tokenUriCid = fullTokenUri

          // ✅ AUTO-GENERATE QR CODE after successful mint
          try {
            const qrData = generateQRCodeData(ticket.id, ticket.ownerAddress)
            ticket.qrCodeData = qrData.qrCodeData
            ticket.qrCodeSecret = qrData.secret
            console.log(`✅ QR code generated for ticket ${ticket.id}`)
          } catch (qrError) {
            console.warn(
              `⚠️ QR code generation failed for ticket ${ticket.id}:`,
              qrError
            )
          }

          await ticket.save()

          console.log(`✅ Ticket ${i + 1} minted successfully:`, {
            ticketId: ticket.id,
            tokenId: mintResponse.token_id,
            transactionHash: mintResponse.transaction_hash
          })

          updatedTickets.push(ticket)
        } else {
          throw new Error(
            `Minting failed: ${mintResponse.message || 'Unknown error'}`
          )
        }
      } catch (mintError) {
        console.error(`❌ Minting failed for ticket ${i + 1}:`, mintError)

        // ✅ SET ticket to MINT_FAILED
        ticket.status = TICKET_STATUS_ENUM[3] // MINT_FAILED
        await ticket.save()

        // Continue with other tickets rather than failing completely
      }
    }

    if (updatedTickets.length === 0) {
      return callback({
        code: grpc.status.INTERNAL,
        message: 'All tickets failed to mint'
      })
    }

    console.log(
      `✅ Successfully minted ${updatedTickets.length}/${pendingTickets.length} tickets`
    )

    // ✅ RETURN success response
    callback(null, {
      tickets: updatedTickets.map(ticketDocumentToGrpcTicket)
    })
  } catch (error) {
    console.error('❌ ConfirmPaymentAndRequestMint error:', error)

    let errorMessage = 'Failed to confirm payment and mint tickets'
    let statusCode = grpc.status.INTERNAL

    if (error.message?.includes('Purchase order not found')) {
      errorMessage = 'Ticket order not found or invalid'
      statusCode = grpc.status.NOT_FOUND
    } else if (
      error.message?.includes('not confirmed') ||
      error.message?.includes('failed on blockchain')
    ) {
      errorMessage = 'Transaction not confirmed on blockchain'
      statusCode = grpc.status.FAILED_PRECONDITION
    } else if (
      error.message?.includes('Invalid') ||
      error.message?.includes('required')
    ) {
      statusCode = grpc.status.INVALID_ARGUMENT
    } else if (error.message?.includes('Metadata not prepared')) {
      statusCode = grpc.status.FAILED_PRECONDITION
    }

    // ✅ LOG failed transaction
    try {
      await TransactionLogger.logTicketPurchase({
        transactionHash: payment_transaction_hash || '',
        eventId: ticketType?.eventId,
        organizerId: null,
        userId: null,
        ticketTypeId: ticketType?.id,
        fromAddress: pendingTickets[0]?.ownerAddress,
        toAddress: process.env.CONTRACT_ADDRESS?.toLowerCase(),
        amountWei: '0',
        platformFeeWei: '0',
        organizerAmountWei: '0',
        feePercentAtTime: 0,
        purchaseId: ticket_order_id,
        ticketIds: pendingTickets.map(t => t.id),
        quantity: pendingTickets.length,
        paymentMethod: 'WALLET',
        failureReason: error.message
      })
    } catch (logError) {
      console.error('Failed to log failed transaction:', logError)
    }

    callback({
      code: statusCode,
      message: errorMessage
    })
  }
}

// ✅ NEW: Log revenue settlement từ blockchain service
async function LogRevenueSettlement (call, callback) {
  try {
    const {
      transaction_hash,
      block_number,
      gas_used,
      gas_price_wei,
      event_id,
      organizer_id,
      organizer_amount_wei,
      platform_fee_wei,
      organizer_address,
      event_name
    } = call.request

    await TransactionLogger.logRevenueSettlement({
      transactionHash: transaction_hash,
      blockNumber: block_number,
      gasUsed: gas_used,
      gasPriceWei: gas_price_wei,
      eventId: event_id,
      organizerId: organizer_id,
      organizerAmountWei: organizer_amount_wei,
      platformFeeWei: platform_fee_wei,
      organizerAddress: organizer_address,
      eventName: event_name
    })

    callback(null, { success: true, message: 'Revenue settlement logged' })
  } catch (error) {
    console.error('LogRevenueSettlement error:', error)
    callback(null, { success: false, message: error.message })
  }
}

// ✅ NEW: Log platform withdraw từ blockchain service
async function LogPlatformWithdraw (call, callback) {
  try {
    const {
      transaction_hash,
      block_number,
      gas_used,
      gas_price_wei,
      amount_wei,
      admin_address
    } = call.request

    await TransactionLogger.logPlatformWithdraw({
      transactionHash: transaction_hash,
      blockNumber: block_number,
      gasUsed: gas_used,
      gasPriceWei: gas_price_wei,
      amountWei: amount_wei,
      adminAddress: admin_address
    })

    callback(null, { success: true, message: 'Platform withdraw logged' })
  } catch (error) {
    console.error('LogPlatformWithdraw error:', error)
    callback(null, { success: false, message: error.message })
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
  GetSoldSeatsByEvent,
  GetMyTicketsWithDetails,
  GetAdminAnalytics,
  GetOrganizerAnalytics,
  LogRevenueSettlement,
  LogPlatformWithdraw
}
