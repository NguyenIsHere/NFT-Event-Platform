const { queryVectors } = require('../utils/vectorUtils')
const { generateEmbedding } = require('./embeddingService')
const eventClient = require('../clients/eventClient')
const userClient = require('../clients/userClient')
const ticketClient = require('../clients/ticketClient')

async function searchSimilarContent (query, contextFilters = [], topK = 5) {
  try {
    // 1. Generate embedding cho query
    const queryEmbedding = await generateEmbedding(query)

    // 2. Tạo filter cho Pinecone dựa trên contextFilters
    const filter = buildPineconeFilter(contextFilters)

    // 3. Search trong vector DB
    const vectorResults = await queryVectors(queryEmbedding, topK, filter)

    // 4. Enrich kết quả với data từ các service
    const enrichedResults = await enrichResultsWithServiceData(vectorResults)

    return enrichedResults
  } catch (error) {
    console.error('Error in searchSimilarContent:', error)
    throw error
  }
}

function buildPineconeFilter (contextFilters) {
  if (!contextFilters || contextFilters.length === 0) {
    return {}
  }

  // Filter theo type: events, tickets, users
  return {
    type: { $in: contextFilters }
  }
}

async function enrichResultsWithServiceData (vectorResults) {
  const enrichedResults = []

  for (const match of vectorResults) {
    try {
      const metadata = match.metadata
      let enrichedData = {
        id: metadata.id,
        type: metadata.type,
        title: metadata.title,
        content: metadata.content,
        score: match.score
      }

      // Lấy thêm data chi tiết từ service tương ứng
      switch (metadata.type) {
        case 'event':
          const eventDetail = await eventClient.getEventById(metadata.id)
          if (eventDetail) {
            enrichedData.title = eventDetail.name
            enrichedData.content = `Sự kiện: ${eventDetail.name}. Mô tả: ${
              eventDetail.description
            }. Ca sĩ: ${eventDetail.artist}. Địa điểm: ${
              eventDetail.location
            }. Thời gian: ${new Date(eventDetail.date).toLocaleDateString(
              'vi-VN'
            )}`
            enrichedData.additionalInfo = {
              artist: eventDetail.artist,
              location: eventDetail.location,
              date: eventDetail.date,
              price: eventDetail.ticket_price
            }
          }
          break

        case 'ticket':
          const ticketDetail = await ticketClient.getTicketById(metadata.id)
          if (ticketDetail) {
            enrichedData.title = `Vé ${ticketDetail.type}`
            enrichedData.content = `Vé loại ${ticketDetail.type} cho sự kiện ID ${ticketDetail.event_id}. Giá: ${ticketDetail.price}. Trạng thái: ${ticketDetail.status}`
            enrichedData.additionalInfo = {
              eventId: ticketDetail.event_id,
              type: ticketDetail.type,
              price: ticketDetail.price,
              status: ticketDetail.status
            }
          }
          break

        case 'user':
          const userDetail = await userClient.getUserById(metadata.id)
          if (userDetail) {
            enrichedData.title = userDetail.username
            enrichedData.content = `Người dùng: ${userDetail.username}. Email: ${userDetail.email}. Role: ${userDetail.role}`
            enrichedData.additionalInfo = {
              username: userDetail.username,
              email: userDetail.email,
              role: userDetail.role
            }
          }
          break
      }

      enrichedResults.push(enrichedData)
    } catch (error) {
      console.error(
        `Error enriching data for ${match.metadata?.type}:${match.metadata?.id}:`,
        error
      )
      // Vẫn trả về data cơ bản nếu không lấy được detail
      enrichedResults.push({
        id: match.metadata?.id,
        type: match.metadata?.type,
        title: match.metadata?.title || 'Unknown',
        content: match.metadata?.content || '',
        score: match.score
      })
    }
  }

  return enrichedResults
}

module.exports = {
  searchSimilarContent
}
