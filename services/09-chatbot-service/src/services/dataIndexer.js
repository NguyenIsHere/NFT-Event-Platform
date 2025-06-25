const eventClient = require('../clients/eventClient')
const userClient = require('../clients/userClient')
const ticketClient = require('../clients/ticketClient')
const { generateBatchEmbeddings } = require('./embeddingService')
const { upsertVectors } = require('../utils/vectorUtils')
const { v4: uuidv4 } = require('uuid')

async function indexExistingData (dataType = null, forceReindex = false) {
  console.log('Starting data indexing process...')

  let totalIndexed = 0

  try {
    if (!dataType || dataType === 'events') {
      const eventCount = await indexEvents(forceReindex)
      totalIndexed += eventCount
      console.log(`Indexed ${eventCount} events`)
    }

    if (!dataType || dataType === 'users') {
      const userCount = await indexUsers(forceReindex)
      totalIndexed += userCount
      console.log(`Indexed ${userCount} users`)
    }

    if (!dataType || dataType === 'tickets') {
      const ticketCount = await indexTickets(forceReindex)
      totalIndexed += ticketCount
      console.log(`Indexed ${ticketCount} tickets`)
    }

    console.log(`Data indexing completed. Total indexed: ${totalIndexed}`)
    return { count: totalIndexed }
  } catch (error) {
    console.error('Error during data indexing:', error)
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

    // Prepare texts for embedding
    const eventTexts = events.map(
      event => `${event.name} ${event.description} ${event.location}` // ← SỬA: bỏ artist
    )

    // Generate embeddings
    const embeddings = await generateBatchEmbeddings(eventTexts)

    // Prepare vectors for Pinecone
    const vectors = events.map((event, index) => ({
      id: `event_${event.id}`,
      values: embeddings[index],
      metadata: {
        id: event.id,
        type: 'event',
        title: event.name,
        content: `Sự kiện: ${event.name}. Mô tả: ${event.description}. Địa điểm: ${event.location}`, // ← SỬA: bỏ artist, date
        location: event.location,
        organizer_id: event.organizer_id,
        status: event.status,
        is_active: event.is_active
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

async function indexTickets (forceReindex = false) {
  try {
    console.log('Fetching tickets from ticket service...')
    const tickets = await ticketClient.getAllTickets()

    if (!tickets || tickets.length === 0) {
      console.log('No tickets found to index')
      return 0
    }

    console.log(`Processing ${tickets.length} tickets...`)

    // ✅ FIX: Map đúng fields từ ticket.proto
    const ticketTexts = tickets.map(ticket => {
      // Ticket fields từ proto: id, event_id, ticket_type_id, status, owner_address, etc.
      const eventId = ticket.event_id || 'unknown'
      const status = ticket.status || 'unknown'
      const ticketTypeId = ticket.ticket_type_id || 'standard'
      const ownerAddress = ticket.owner_address || 'unknown'

      return `vé ${ticketTypeId} sự kiện ${eventId} trạng thái ${status} chủ sở hữu ${ownerAddress}`
    })

    // Generate embeddings
    const embeddings = await generateBatchEmbeddings(ticketTexts)

    // ✅ FIX: Map đúng metadata fields
    const vectors = tickets.map((ticket, index) => ({
      id: `ticket_${ticket.id}`,
      values: embeddings[index],
      metadata: {
        id: ticket.id,
        type: 'ticket',
        title: `Vé cho sự kiện ${ticket.event_id}`,
        content: `Vé ID ${ticket.id} cho sự kiện ${ticket.event_id}. Trạng thái: ${ticket.status}. Chủ sở hữu: ${ticket.owner_address}`,
        event_id: ticket.event_id,
        ticket_type_id: ticket.ticket_type_id,
        status: ticket.status,
        owner_address: ticket.owner_address,
        token_id: ticket.token_id || '',
        check_in_status: ticket.check_in_status || 'NOT_CHECKED_IN'
      }
    }))

    // Upsert to vector database
    await upsertVectors(vectors)

    return tickets.length
  } catch (error) {
    console.error('Error indexing tickets:', error)
    return 0
  }
}

// Scheduled indexing (chạy định kỳ để update data)
async function schedulePeriodicIndexing () {
  console.log('Setting up periodic data indexing...')

  // Index lại data mỗi 6 tiếng
  setInterval(async () => {
    console.log('Running scheduled data indexing...')
    try {
      await indexExistingData()
    } catch (error) {
      console.error('Scheduled indexing failed:', error)
    }
  }, 6 * 60 * 60 * 1000) // 6 hours
}

module.exports = {
  indexExistingData,
  indexEvents,
  indexUsers,
  indexTickets,
  schedulePeriodicIndexing
}
