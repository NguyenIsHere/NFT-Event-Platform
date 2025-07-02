// 05-ticket-service/src/handlers/ticketTypeServiceHandlers.js (KHUNG SƯỜN CHI TIẾT HƠN)
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')
const eventServiceClient = require('../clients/eventServiceClient') // Import eventServiceClient
const blockchainServiceClient = require('../clients/blockchainServiceClient')

// Helper to convert Mongoose doc to proto message
function ticketTypeToProto (ttDoc) {
  if (!ttDoc) return null
  const ttData = ttDoc.toJSON ? ttDoc.toJSON() : { ...ttDoc }
  return {
    id: ttData.id || ttDoc._id?.toString(),
    event_id: ttData.eventId || '',
    session_id: ttData.sessionId || '', // Thêm session_id
    contract_session_id: ttData.contractSessionId || '',
    blockchain_event_id: ttData.blockchainEventId || '',
    blockchain_ticket_type_id: ttData.blockchainTicketTypeId || '',
    name: ttData.name || '',
    total_quantity: ttData.totalQuantity || 0,
    available_quantity: ttData.availableQuantity || 0,
    price_wei: ttData.priceWei || '0',
    created_at: ttDoc.createdAt
      ? Math.floor(new Date(ttDoc.createdAt).getTime() / 1000)
      : 0,
    updated_at: ttDoc.updatedAt
      ? Math.floor(new Date(ttDoc.updatedAt).getTime() / 1000)
      : 0
  }
}

async function CreateTicketType (call, callback) {
  const { event_id, session_id, name, total_quantity, price_wei } = call.request

  console.log(`TicketTypeService: CreateTicketType called with:`, {
    event_id: `"${event_id}" (type: ${typeof event_id}, length: ${
      event_id?.length
    })`,
    session_id: `"${session_id}" (type: ${typeof session_id}, length: ${
      session_id?.length
    })`,
    name: `"${name}"`,
    total_quantity,
    price_wei: `"${price_wei}"`
  })

  try {
    // ✅ VALIDATE REQUIRED FIELDS
    if (!event_id || typeof event_id !== 'string' || event_id.trim() === '') {
      console.error('❌ Invalid event_id:', { event_id, type: typeof event_id })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `event_id is required and must be a non-empty string. Received: "${event_id}"`
      })
    }

    if (
      !session_id ||
      typeof session_id !== 'string' ||
      session_id.trim() === ''
    ) {
      console.error('❌ Invalid session_id:', {
        session_id,
        type: typeof session_id
      })
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `session_id is required and must be a non-empty string. Received: "${session_id}"`
      })
    }

    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      console.error('❌ Invalid event_id format:', event_id)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid event_id format: "${event_id}". Expected MongoDB ObjectId.`
      })
    }

    if (!mongoose.Types.ObjectId.isValid(session_id)) {
      console.error('❌ Invalid session_id format:', session_id)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid session_id format: "${session_id}". Expected MongoDB ObjectId.`
      })
    }

    // ✅ FETCH EVENT AND SESSION INFO FOR VALIDATION ONLY
    console.log(
      `TicketTypeService: Fetching event details from EventService for event ID: ${event_id}`
    )

    const eventResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) {
            console.error('❌ EventService.GetEvent error:', err)
            reject(new Error(`Failed to fetch event: ${err.message}`))
          } else {
            console.log('✅ EventService.GetEvent success:', res)
            resolve(res)
          }
        }
      )
    })

    if (!eventResponse || !eventResponse.event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Event with ID ${event_id} not found.`
      })
    }

    const parentEvent = eventResponse.event
    console.log(`🔍 Parent event sessions:`, parentEvent.sessions)

    // ✅ FIND TARGET SESSION
    const targetSession = parentEvent.sessions.find(s => {
      console.log(
        `🔍 Comparing session: "${s.id}" === "${session_id}"`,
        s.id === session_id
      )
      return s.id === session_id
    })

    if (!targetSession) {
      console.error(
        `❌ Session not found in event. Looking for: "${session_id}"`
      )
      console.error(
        'Available sessions:',
        parentEvent.sessions.map(s => ({ id: s.id, name: s.name }))
      )
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Session with ID "${session_id}" not found in event "${event_id}".`
      })
    }

    // ✅ VALIDATE CONTRACT SESSION ID EXISTS
    if (!targetSession.contract_session_id) {
      console.error(`❌ Session missing contract_session_id:`, targetSession)
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Session "${session_id}" is missing contract_session_id. Event may not be properly published.`
      })
    }

    const contractSessionIdFromEvent = targetSession.contract_session_id
    console.log(
      `✅ Found session with contract_session_id: "${contractSessionIdFromEvent}"`
    )

    // ✅ CREATE TICKET TYPE DRAFT (NO BLOCKCHAIN VALIDATION OR AUTO-PUBLISH)
    const newTicketType = new TicketType({
      eventId: event_id,
      sessionId: session_id,
      contractSessionId: contractSessionIdFromEvent,
      blockchainEventId: '', // ❌ KHÔNG GHI blockchain event id khi tạo draft
      blockchainTicketTypeId: '', // ❌ KHÔNG GHI blockchain ticket type id khi tạo draft
      name,
      totalQuantity: total_quantity,
      availableQuantity: total_quantity,
      priceWei: price_wei
    })

    const savedTicketType = await newTicketType.save()

    console.log(
      `✅ TicketType DRAFT "${name}" created with ID ${savedTicketType.id} for session ${session_id}`
    )

    // ❌ REMOVED: Tất cả logic blockchain validation và auto-publish
    // Sẽ được xử lý riêng trong PublishTicketType

    callback(null, ticketTypeToProto(savedTicketType))
  } catch (error) {
    console.error('❌ TicketTypeService: CreateTicketType RPC error:', error)

    if (
      error.code === 11000 ||
      (error.message && error.message.includes('duplicate key'))
    ) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `TicketType "${name}" already exists for this event.`
      })
    }

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
      message: error.message || 'Failed to create ticket type draft.'
    })
  }
}

async function UpdateTicketType (call, callback) {
  const { ticket_type_id, blockchain_event_id /*, các trường khác nếu có */ } =
    call.request
  console.log(
    `TicketTypeService: UpdateTicketType called for ID: ${ticket_type_id} with blockchain_event_id: ${blockchain_event_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    const updateData = {}
    if (blockchain_event_id) {
      // Chỉ cập nhật nếu được cung cấp
      updateData.blockchainEventId = blockchain_event_id
    }
    // Thêm các trường khác vào updateData nếu message UpdateTicketTypeRequest có chúng
    // if (call.request.name && call.request.name.value) updateData.name = call.request.name.value;
    // if (call.request.total_quantity && call.request.total_quantity.value !== undefined) {
    //   updateData.totalQuantity = call.request.total_quantity.value;
    //   // Cân nhắc cập nhật availableQuantity tương ứng nếu totalQuantity thay đổi
    // }

    if (Object.keys(updateData).length === 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'No update fields provided.'
      })
    }

    const updatedTicketType = await TicketType.findByIdAndUpdate(
      ticket_type_id,
      { $set: updateData },
      { new: true } // Trả về document đã được cập nhật
    )

    if (!updatedTicketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found to update.'
      })
    }
    console.log(
      `TicketTypeService: TicketType ${updatedTicketType.id} updated. BlockchainEventId set to ${updatedTicketType.blockchainEventId}`
    )
    callback(null, ticketTypeToProto(updatedTicketType))
  } catch (error) {
    console.error('TicketTypeService: UpdateTicketType RPC error:', error)
    if (error.code === 11000) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message:
          'Update would cause a duplicate key violation (e.g., blockchainEventId if it has unique constraint with other fields).'
      })
    }
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to update ticket type.'
    })
  }
}

async function GetTicketType (call, callback) {
  const { ticket_type_id } = call.request
  console.log(`TicketService: GetTicketType for ID: ${ticket_type_id}`)
  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }
    callback(null, ticketTypeToProto(ticketType))
  } catch (error) {
    console.error('TicketService: GetTicketType RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to get ticket type.'
    })
  }
}

async function ListTicketTypesByEvent (call, callback) {
  const { event_id } = call.request
  console.log(`TicketService: ListTicketTypesByEvent for event_id: ${event_id}`)
  try {
    if (!mongoose.Types.ObjectId.isValid(event_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id format.'
      })
    }

    const ticketTypes = await TicketType.find({ eventId: event_id }).sort({
      createdAt: 1
    })

    // ✅ NEW: Calculate real availability for each ticket type
    const ticketTypesWithRealAvailability = await Promise.all(
      ticketTypes.map(async ticketType => {
        const soldTicketsCount = await Ticket.countDocuments({
          ticketTypeId: ticketType._id.toString(),
          status: { $in: ['PAID', 'MINTING', 'MINTED'] }
        })

        const realAvailableQuantity = Math.max(
          0,
          ticketType.totalQuantity - soldTicketsCount
        )

        // Update availability in database if different
        if (ticketType.availableQuantity !== realAvailableQuantity) {
          await TicketType.findByIdAndUpdate(
            ticketType._id,
            { availableQuantity: realAvailableQuantity },
            { new: false }
          )
          console.log(
            `TicketType ${ticketType._id} availability updated: ${realAvailableQuantity}`
          )
        }

        // Return updated ticket type
        return {
          ...ticketType.toJSON(),
          availableQuantity: realAvailableQuantity
        }
      })
    )

    callback(null, {
      ticket_types: ticketTypesWithRealAvailability.map(tt =>
        ticketTypeToProto(tt)
      )
    })
  } catch (error) {
    console.error('TicketService: ListTicketTypesByEvent RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to list ticket types for event.'
    })
  }
}

async function ListTicketTypesBySession (call, callback) {
  const { event_id, session_id } = call.request
  console.log(
    `TicketTypeService: ListTicketTypesBySession for event_id: ${event_id}, session_id: ${session_id}`
  )
  try {
    if (
      !mongoose.Types.ObjectId.isValid(event_id) ||
      (session_id && !mongoose.Types.ObjectId.isValid(session_id))
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid event_id or session_id format.'
      })
    }

    const query = { eventId: event_id }
    if (session_id) {
      query.sessionId = session_id
    }

    const ticketTypes = await TicketType.find(query).sort({ createdAt: 1 })

    // ✅ NEW: Calculate real availability for each ticket type
    const ticketTypesWithRealAvailability = await Promise.all(
      ticketTypes.map(async ticketType => {
        const soldTicketsCount = await Ticket.countDocuments({
          ticketTypeId: ticketType._id.toString(),
          status: { $in: ['PAID', 'MINTING', 'MINTED'] }
        })

        const realAvailableQuantity = Math.max(
          0,
          ticketType.totalQuantity - soldTicketsCount
        )

        // Update availability in database if different
        if (ticketType.availableQuantity !== realAvailableQuantity) {
          await TicketType.findByIdAndUpdate(
            ticketType._id,
            { availableQuantity: realAvailableQuantity },
            { new: false }
          )
          console.log(
            `TicketType ${ticketType._id} availability updated: ${realAvailableQuantity}`
          )
        }

        return {
          ...ticketType.toJSON(),
          availableQuantity: realAvailableQuantity
        }
      })
    )

    callback(null, {
      ticket_types: ticketTypesWithRealAvailability.map(tt =>
        ticketTypeToProto(tt)
      )
    })
  } catch (error) {
    console.error(
      'TicketTypeService: ListTicketTypesBySession RPC error:',
      error
    )
    callback({
      code: grpc.status.INTERNAL,
      message: 'Failed to list ticket types for session.'
    })
  }
}

async function GetTicketTypeWithAvailability (call, callback) {
  const { ticket_type_id } = call.request
  console.log(
    `TicketService: GetTicketTypeWithAvailability for ID: ${ticket_type_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    // ✅ FIX: Implement the method properly
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    // ✅ REMOVE: const { Ticket } = require('../models/Ticket') - đã import ở đầu file

    // Calculate real available quantity from actual tickets
    const soldTicketsCount = await Ticket.countDocuments({
      ticketTypeId: ticket_type_id,
      status: { $in: ['PAID', 'MINTING', 'MINTED'] }
    })

    const realAvailableQuantity = Math.max(
      0,
      ticketType.totalQuantity - soldTicketsCount
    )

    // Update available quantity if needed
    if (ticketType.availableQuantity !== realAvailableQuantity) {
      ticketType.availableQuantity = realAvailableQuantity
      await ticketType.save()
      console.log(
        `TicketType ${ticket_type_id} availability updated: ${realAvailableQuantity}`
      )
    }

    callback(null, ticketTypeToProto(ticketType))
  } catch (error) {
    console.error('TicketService: GetTicketTypeWithAvailability error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get ticket type with availability.'
    })
  }
}

async function PublishTicketType (call, callback) {
  const { ticket_type_id } = call.request
  console.log(
    `TicketTypeService: PublishTicketType called for ID: ${ticket_type_id}`
  )

  try {
    if (!mongoose.Types.ObjectId.isValid(ticket_type_id)) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid ticket_type_id format.'
      })
    }

    // ✅ FETCH TICKET TYPE
    const ticketType = await TicketType.findById(ticket_type_id)
    if (!ticketType) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'TicketType not found.'
      })
    }

    console.log(`🔍 Publishing ticket type:`, {
      id: ticketType.id,
      name: ticketType.name,
      eventId: ticketType.eventId,
      blockchainTicketTypeId: ticketType.blockchainTicketTypeId
    })

    // ✅ CHECK IF ALREADY PUBLISHED
    if (
      ticketType.blockchainTicketTypeId &&
      ticketType.blockchainTicketTypeId !== ''
    ) {
      return callback({
        code: grpc.status.ALREADY_EXISTS,
        message: `TicketType "${ticketType.name}" is already published to blockchain with ID: ${ticketType.blockchainTicketTypeId}`
      })
    }

    // ✅ NOW FETCH PARENT EVENT TO GET BLOCKCHAIN EVENT ID
    console.log(
      `🔍 Fetching parent event to get blockchain_event_id for event: ${ticketType.eventId}`
    )

    const eventResponse = await new Promise((resolve, reject) => {
      eventServiceClient.GetEvent(
        { event_id: ticketType.eventId },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) {
            console.error('❌ EventService.GetEvent error:', err)
            reject(new Error(`Failed to fetch event: ${err.message}`))
          } else {
            resolve(res)
          }
        }
      )
    })

    if (!eventResponse || !eventResponse.event) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Parent event with ID ${ticketType.eventId} not found.`
      })
    }

    const parentEvent = eventResponse.event

    // ✅ VALIDATE PARENT EVENT IS PUBLISHED
    if (
      !parentEvent.blockchain_event_id ||
      parentEvent.blockchain_event_id === '0' ||
      parentEvent.blockchain_event_id === ''
    ) {
      console.error(`❌ Parent event not published to blockchain:`, {
        eventId: ticketType.eventId,
        blockchainEventId: parentEvent.blockchain_event_id,
        status: parentEvent.status
      })
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Parent event "${
          ticketType.eventId
        }" must be published to blockchain first. Current blockchain_event_id: "${
          parentEvent.blockchain_event_id || 'NONE'
        }"`
      })
    }

    console.log(
      `✅ Parent event has valid blockchain_event_id: "${parentEvent.blockchain_event_id}"`
    )

    // ✅ UPDATE TICKET TYPE WITH BLOCKCHAIN EVENT ID
    ticketType.blockchainEventId = parentEvent.blockchain_event_id
    await ticketType.save()

    console.log(
      `✅ Updated ticket type with blockchain_event_id: ${parentEvent.blockchain_event_id}`
    )

    // ✅ CALL BLOCKCHAIN SERVICE TO REGISTER TICKET TYPE
    const bcResponse = await new Promise((resolve, reject) => {
      blockchainServiceClient.RegisterTicketTypeOnBlockchain(
        {
          blockchain_event_id: parentEvent.blockchain_event_id,
          ticket_type_name: ticketType.name,
          price_wei: ticketType.priceWei,
          total_supply: ticketType.totalQuantity.toString()
        },
        (error, response) => {
          if (error) {
            console.error('❌ Blockchain service error:', error)
            reject(error)
          } else {
            console.log('✅ Blockchain service response:', response)
            resolve(response)
          }
        }
      )
    })

    if (bcResponse && bcResponse.success) {
      // ✅ UPDATE TICKET TYPE WITH BLOCKCHAIN TICKET TYPE ID
      ticketType.blockchainTicketTypeId = bcResponse.blockchain_ticket_type_id
      await ticketType.save()

      console.log(
        `✅ TicketType "${ticketType.name}" published successfully with blockchain ID: ${bcResponse.blockchain_ticket_type_id}`
      )

      callback(null, {
        success: true,
        message: `TicketType "${ticketType.name}" published successfully`,
        ticket_type: ticketTypeToProto(ticketType),
        blockchain_ticket_type_id: bcResponse.blockchain_ticket_type_id,
        transaction_hash: bcResponse.transaction_hash
      })
    } else {
      throw new Error(
        'Blockchain registration failed: ' +
          (bcResponse?.message || 'Unknown error')
      )
    }
  } catch (error) {
    console.error('❌ TicketTypeService: PublishTicketType error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to publish ticket type.'
    })
  }
}

// Thêm hàm mới
async function ListAllTicketTypes (call, callback) {
  const {
    page_size = 20,
    page_token,
    status_filter,
    organizer_id,
    event_id
  } = call.request

  console.log(`TicketTypeService: ListAllTicketTypes called with filters:`, {
    page_size,
    page_token,
    status_filter,
    organizer_id,
    event_id
  })

  try {
    // Build query filter
    const query = {}

    if (event_id) {
      if (!mongoose.Types.ObjectId.isValid(event_id)) {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Invalid event_id format.'
        })
      }
      query.eventId = event_id
    }

    // For organizer filter, we need to join with events
    let pipeline = []

    if (organizer_id) {
      // Use aggregation pipeline to join with events collection
      pipeline = [
        {
          $lookup: {
            from: 'events',
            localField: 'eventId',
            foreignField: '_id',
            as: 'event'
          }
        },
        {
          $match: {
            'event.organizerId': organizer_id,
            ...query
          }
        }
      ]
    } else {
      // Simple find if no organizer filter
      pipeline = [{ $match: query }]
    }

    // Add status filter based on blockchain fields
    if (status_filter) {
      let statusMatch = {}
      switch (status_filter.toLowerCase()) {
        case 'draft':
          statusMatch = {
            $or: [
              { blockchainTicketTypeId: { $exists: false } },
              { blockchainTicketTypeId: '' }
            ]
          }
          break
        case 'created':
          statusMatch = {
            blockchainTicketTypeId: { $exists: true, $ne: '' }
          }
          break
        case 'published':
          statusMatch = {
            blockchainTicketTypeId: { $exists: true, $ne: '' }
          }
          break
      }
      pipeline.push({ $match: statusMatch })
    }

    // Add pagination
    let skip = 0
    if (page_token && !isNaN(parseInt(page_token))) {
      skip = parseInt(page_token)
    }

    pipeline.push(
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(page_size) }
    )

    // Execute aggregation
    const ticketTypes = await TicketType.aggregate(pipeline)

    // Get total count for pagination
    const countPipeline = [...pipeline.slice(0, -2)] // Remove skip and limit
    countPipeline.push({ $count: 'total' })
    const countResult = await TicketType.aggregate(countPipeline)
    const totalCount = countResult[0]?.total || 0

    // Convert to proto format
    const protoTicketTypes = ticketTypes.map(tt => {
      // Handle aggregation result format
      const ticketTypeDoc = tt.event ? tt : { ...tt, event: null }
      return ticketTypeToProto(ticketTypeDoc)
    })

    // Calculate next page token
    const nextPageToken =
      skip + protoTicketTypes.length < totalCount
        ? (skip + parseInt(page_size)).toString()
        : ''

    console.log(
      `TicketTypeService: Returning ${protoTicketTypes.length} ticket types out of ${totalCount} total`
    )

    callback(null, {
      ticket_types: protoTicketTypes,
      next_page_token: nextPageToken,
      total_count: totalCount
    })
  } catch (error) {
    console.error('TicketTypeService: ListAllTicketTypes RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list all ticket types.'
    })
  }
}

// ✅ Export hàm mới
module.exports = {
  CreateTicketType,
  UpdateTicketType,
  GetTicketType,
  GetTicketTypeWithAvailability,
  ListTicketTypesByEvent,
  ListTicketTypesBySession,
  PublishTicketType,
  ListAllTicketTypes // ✅ NEW
}
