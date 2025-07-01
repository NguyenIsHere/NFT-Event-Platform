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
            // ✅ FIX: Use correct event fields
            enrichedData.title = eventDetail.name
            enrichedData.content = `Sự kiện: ${eventDetail.name}. Mô tả: ${
              eventDetail.description || 'Không có mô tả'
            }. Địa điểm: ${
              eventDetail.location || 'Chưa xác định'
            }. Trạng thái: ${eventDetail.status}. ${
              eventDetail.is_active ? 'Đang mở bán vé' : 'Chưa mở bán'
            }`

            enrichedData.additionalInfo = {
              location: eventDetail.location,
              status: eventDetail.status,
              is_active: eventDetail.is_active,
              organizer_id: eventDetail.organizer_id,
              sessions_count: eventDetail.sessions?.length || 0
            }
          }
          break

        case 'ticket':
          const ticketDetail = await ticketClient.getTicketById(metadata.id)
          if (ticketDetail) {
            // ✅ FIX: Use correct ticket fields
            enrichedData.title = `Vé sự kiện ${ticketDetail.event_id}`
            enrichedData.content = `Vé ID ${ticketDetail.id} cho sự kiện ${ticketDetail.event_id}. Loại vé: ${ticketDetail.ticket_type_id}. Trạng thái: ${ticketDetail.status}. Check-in: ${ticketDetail.check_in_status}`

            enrichedData.additionalInfo = {
              event_id: ticketDetail.event_id,
              ticket_type_id: ticketDetail.ticket_type_id,
              status: ticketDetail.status,
              owner_address: ticketDetail.owner_address,
              check_in_status: ticketDetail.check_in_status,
              token_id: ticketDetail.token_id
            }
          }
          break

        case 'user':
          const userDetail = await userClient.getUserById(metadata.id)
          if (userDetail) {
            enrichedData.title = userDetail.full_name || userDetail.email
            enrichedData.content = `Người dùng: ${
              userDetail.full_name || userDetail.email
            }. Email: ${userDetail.email}. Role: ${userDetail.role}`
            enrichedData.additionalInfo = {
              email: userDetail.email,
              role: userDetail.role,
              wallet_address: userDetail.wallet_address
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
