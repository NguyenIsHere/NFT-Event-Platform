const eventClient = require('../clients/eventClient')
const userClient = require('../clients/userClient')
const ticketClient = require('../clients/ticketClient')
const { generateBatchEmbeddings } = require('./embeddingService')
const { upsertVectors } = require('../utils/vectorUtils')
const { v4: uuidv4 } = require('uuid')
const indexingManager = require('./indexingManager')

async function indexExistingData (dataType = null, forceReindex = false) {
  console.log('🔍 Checking if indexing is needed...')

  let totalIndexed = 0

  try {
    // ✅ SMART CHECK: Only index what's needed
    if (!forceReindex) {
      const reindexNeeds = await indexingManager.shouldReindex(dataType)

      if (reindexNeeds.reason.length > 0) {
        console.log('📊 Reindex reasons:', reindexNeeds.reason)
      } else {
        console.log('✅ No indexing needed - data is up to date')
        return { count: 0, skipped: true }
      }

      // Index only what needs updating
      if (!dataType || dataType === 'events') {
        if (reindexNeeds.events) {
          const eventCount = await indexEvents(forceReindex)
          totalIndexed += eventCount
          await indexingManager.updateIndexedCounts('events', eventCount)
          console.log(`📚 Indexed ${eventCount} events`)
        } else {
          console.log('⏭️  Skipping events - no changes detected')
        }
      }

      if (!dataType || dataType === 'tickets') {
        if (reindexNeeds.tickets) {
          const ticketCount = await indexTickets(forceReindex)
          totalIndexed += ticketCount
          await indexingManager.updateIndexedCounts('tickets', ticketCount)
          console.log(`🎫 Indexed ${ticketCount} tickets`)
        } else {
          console.log('⏭️  Skipping tickets - no changes detected')
        }
      }
    } else {
      // Force reindex all
      console.log('🔄 Force reindexing all data...')

      if (!dataType || dataType === 'events') {
        const eventCount = await indexEvents(forceReindex)
        totalIndexed += eventCount
        await indexingManager.updateIndexedCounts('events', eventCount)
        console.log(`📚 Force indexed ${eventCount} events`)
      }

      if (!dataType || dataType === 'tickets') {
        const ticketCount = await indexTickets(forceReindex)
        totalIndexed += ticketCount
        await indexingManager.updateIndexedCounts('tickets', ticketCount)
        console.log(`🎫 Force indexed ${ticketCount} tickets`)
      }
    }

    // Skip users (privacy)
    if (!dataType || dataType === 'users') {
      console.log('⏭️  Skipping users - privacy policy')
    }

    console.log(`✅ Indexing completed. Total indexed: ${totalIndexed}`)
    return { count: totalIndexed, skipped: false }
  } catch (error) {
    console.error('❌ Error during intelligent indexing:', error)
    throw error
  }
}

async function indexEvents (forceReindex = false) {
  try {
    console.log('Fetching events from event service...')
    const events = await eventClient.getAllEvents()

    if (!events || events.length === 0) {
      console.log('No events found to index')
      return 0
    }

    console.log(`Processing ${events.length} events...`)

    // ✅ FIX: Use correct event fields
    const eventTexts = events.map(event => {
      // Event fields: name, description, location, organizer_id, status
      const eventDesc = event.description || ''
      const eventLocation = event.location || ''

      return `sự kiện ${event.name} ${eventDesc} địa điểm ${eventLocation}`
    })

    // Generate embeddings
    const embeddings = await generateBatchEmbeddings(eventTexts)

    // ✅ FIX: Use correct metadata fields
    const vectors = events.map((event, index) => ({
      id: `event_${event.id}`,
      values: embeddings[index],
      metadata: {
        id: event.id,
        type: 'event',
        title: event.name,
        content: `Sự kiện: ${event.name}. Mô tả: ${
          event.description || 'Không có mô tả'
        }. Địa điểm: ${event.location || 'Chưa xác định'}. Trạng thái: ${
          event.status
        }`,
        location: event.location || '',
        organizer_id: event.organizer_id || '',
        status: event.status || 'DRAFT',
        is_active: event.is_active || false
      }
    }))

    // Upsert to vector database
    await upsertVectors(vectors)

    return events.length
  } catch (error) {
    console.error('Error indexing events:', error)
    return 0
  }
}

// ✅ THÊM: Cache events để tránh gọi API nhiều lần
let eventsCache = null
let eventsCacheTime = null
const CACHE_DURATION = 5 * 60 * 1000 // 5 phút

async function getEventsWithCache () {
  const now = Date.now()

  if (
    eventsCache &&
    eventsCacheTime &&
    now - eventsCacheTime < CACHE_DURATION
  ) {
    console.log('Using cached events data')
    return eventsCache
  }

  console.log('Fetching fresh events data...')
  const events = await eventClient.getAllEvents()

  eventsCache = events
  eventsCacheTime = now

  return events
}

async function indexTickets (forceReindex = false) {
  try {
    console.log('Fetching tickets from ticket service...')
    const tickets = await ticketClient.getAllTickets()

    if (!tickets || tickets.length === 0) {
      console.log('No tickets found to index')
      return 0
    }

    console.log(`Processing ${tickets.length} tickets...`)

    // ✅ THÊM: Fetch events để enrichment
    console.log('Fetching events for ticket enrichment...')
    const events = await getEventsWithCache()

    // ✅ THÊM: Tạo event lookup map
    const eventMap = new Map()
    if (events && events.length > 0) {
      events.forEach(event => {
        eventMap.set(event.id, {
          name: event.name,
          location: event.location,
          status: event.status
        })
      })
    }

    // ✅ CẬP NHẬT: Enrich ticket texts với event name
    const ticketTexts = tickets.map(ticket => {
      const eventId = ticket.event_id || 'unknown'
      const status = ticket.status || 'unknown'
      const ticketTypeId = ticket.ticket_type_id || 'standard'
      const ownerAddress = ticket.owner_address || 'unknown'
      const checkInStatus = ticket.check_in_status || 'NOT_CHECKED_IN'

      // ✅ THÊM: Lấy event name từ cache
      const eventInfo = eventMap.get(eventId)
      const eventName = eventInfo?.name || `sự kiện ${eventId}`
      const eventLocation = eventInfo?.location || ''

      return `vé ${ticketTypeId} cho ${eventName} tại ${eventLocation} trạng thái ${status} chủ sở hữu ${ownerAddress} check-in ${checkInStatus}`
    })

    // Generate embeddings
    const embeddings = await generateBatchEmbeddings(ticketTexts)

    // ✅ CẬP NHẬT: Enrich metadata với event info
    const vectors = tickets.map((ticket, index) => {
      const eventInfo = eventMap.get(ticket.event_id)
      const eventName = eventInfo?.name || `Event ${ticket.event_id}`

      return {
        id: `ticket_${ticket.id}`,
        values: embeddings[index],
        metadata: {
          id: ticket.id,
          type: 'ticket',
          title: `Vé cho ${eventName}`,
          content: `Vé ID ${ticket.id} cho ${eventName}. Trạng thái: ${ticket.status}. Chủ sở hữu: ${ticket.owner_address}. Check-in: ${ticket.check_in_status}`,
          event_id: ticket.event_id,
          event_name: eventName, // ✅ THÊM: Lưu event name
          event_location: eventInfo?.location || '',
          event_status: eventInfo?.status || '',
          ticket_type_id: ticket.ticket_type_id,
          status: ticket.status,
          owner_address: ticket.owner_address,
          token_id: ticket.token_id || '',
          check_in_status: ticket.check_in_status || 'NOT_CHECKED_IN',
          session_id: ticket.session_id || ''
        }
      }
    })

    // Upsert to vector database
    await upsertVectors(vectors)

    return tickets.length
  } catch (error) {
    console.error('Error indexing tickets:', error)
    return 0
  }
}

async function indexUsers (forceReindex = false) {
  try {
    console.log('Fetching users from user service...')
    const users = await userClient.getAllUsers()

    if (!users || users.length === 0) {
      console.log('No users found to index')
      return 0
    }

    console.log(`Processing ${users.length} users...`)

    // Prepare texts for embedding
    const userTexts = users.map(
      user =>
        `${user.username} ${user.email} ${user.role || ''} ${user.bio || ''}`
    )

    // Generate embeddings
    const embeddings = await generateBatchEmbeddings(userTexts)

    // Prepare vectors for Pinecone
    const vectors = users.map((user, index) => ({
      id: `user_${user.id}`,
      values: embeddings[index],
      metadata: {
        id: user.id,
        type: 'user',
        title: user.username,
        content: `Người dùng: ${user.username}. Email: ${user.email}. Role: ${
          user.role || 'user'
        }`,
        username: user.username,
        email: user.email,
        role: user.role || 'user'
      }
    }))

    // Upsert to vector database
    await upsertVectors(vectors)

    return users.length
  } catch (error) {
    console.error('Error indexing users:', error)
    return 0
  }
}

async function schedulePeriodicIndexing () {
  console.log('⏰ Setting up intelligent periodic indexing evry 30s')

  // Check every 2 hours instead of reindexing every 6 hours
  setInterval(async () => {
    console.log('🔍 Running periodic indexing check...')
    try {
      const result = await indexExistingData()
      if (result.skipped) {
        console.log('✅ Periodic check: No indexing needed')
      } else {
        console.log(`✅ Periodic indexing: ${result.count} items processed`)
      }
    } catch (error) {
      console.error('❌ Periodic indexing failed:', error)
    }
  }, 30 * 1000) // Check every 30s
}

module.exports = {
  indexExistingData,
  indexEvents,
  indexUsers,
  indexTickets,
  schedulePeriodicIndexing
}
