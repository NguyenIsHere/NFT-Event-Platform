const { queryVectors } = require('../utils/vectorUtils')
const { generateEmbedding } = require('./embeddingService')
const eventClient = require('../clients/eventClient')
const userClient = require('../clients/userClient')
const ticketClient = require('../clients/ticketClient')

// ✅ THÊM: Token estimation function
function estimateTokens (text) {
  // Rough estimation: 1 token ≈ 4 characters for Vietnamese
  return Math.ceil(text.length / 4)
}

// ✅ THÊM: Context truncation function
function truncateContext (contextData, maxTokens = 4000) {
  let totalTokens = 0
  const truncatedData = []

  for (const item of contextData) {
    const itemTokens = estimateTokens(item.content)

    if (totalTokens + itemTokens > maxTokens) {
      break // Dừng khi vượt quá limit
    }

    truncatedData.push(item)
    totalTokens += itemTokens
  }

  console.log(
    `Context truncated: ${contextData.length} -> ${truncatedData.length} items (${totalTokens} tokens)`
  )
  return truncatedData
}

// ✅ THÊM: Create summary info function
function createSummaryInfo (contextData) {
  const eventCount = contextData.filter(item => item.type === 'event').length
  const ticketCount = contextData.filter(item => item.type === 'ticket').length

  const activeEvents = contextData.filter(
    item => item.type === 'event' && item.additionalInfo?.is_active
  ).length

  const soldTickets = contextData.filter(
    item => item.type === 'ticket' && item.additionalInfo?.status === 'PAID'
  ).length

  const sampleItems = contextData.slice(0, 3).map(item => item.title)

  return {
    total_events: eventCount,
    total_tickets: ticketCount,
    active_events: activeEvents,
    sold_tickets: soldTickets,
    sample_items: sampleItems,
    is_aggregated: contextData.length > 5
  }
}

// ✅ CẬP NHẬT: searchSimilarContent function
async function searchSimilarContent (
  query,
  contextFilters = [],
  topK = 5,
  queryType = 'SPECIFIC'
) {
  try {
    // 1. Generate embedding cho query
    const queryEmbedding = await generateEmbedding(query)

    // 2. Tạo filter cho Pinecone dựa trên contextFilters
    const filter = buildPineconeFilter(contextFilters)

    // ✅ THÊM: Adaptive topK based on query type
    const adaptiveTopK = queryType === 'LISTING' ? Math.min(topK * 3, 15) : topK
    console.log(
      `Searching with topK: ${adaptiveTopK} (queryType: ${queryType})`
    )

    // 3. Search trong vector DB
    const vectorResults = await queryVectors(
      queryEmbedding,
      adaptiveTopK,
      filter
    )

    // 4. Enrich kết quả với data từ các service
    const enrichedResults = await enrichResultsWithServiceData(vectorResults)

    // ✅ THÊM: Truncate context if needed
    const truncatedResults = truncateContext(enrichedResults)

    return truncatedResults
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

// ✅ THÊM: Cache cho events
let eventsCache = new Map()
let eventsCacheTime = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 phút

async function getEventByIdWithCache (eventId) {
  const now = Date.now()

  // Check cache first
  if (eventsCache.has(eventId) && now - eventsCacheTime < CACHE_DURATION) {
    return eventsCache.get(eventId)
  }

  // Fetch from service
  try {
    const event = await eventClient.getEventById(eventId)
    if (event) {
      eventsCache.set(eventId, event)
      eventsCacheTime = now
    }
    return event
  } catch (error) {
    console.error(`Error fetching event ${eventId}:`, error)
    return null
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
          const eventDetail = await getEventByIdWithCache(metadata.id)
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
            // ✅ THÊM: Lấy event name nếu có trong metadata, nếu không thì gọi API
            let eventName = metadata.event_name

            if (!eventName) {
              const eventInfo = await getEventByIdWithCache(
                ticketDetail.event_id
              )
              eventName = eventInfo?.name || `Event ${ticketDetail.event_id}`
            }

            // ✅ FIX: Use event name thay vì event ID
            enrichedData.title = `Vé cho ${eventName}`
            enrichedData.content = `Vé ID ${ticketDetail.id} cho ${eventName}. Loại vé: ${ticketDetail.ticket_type_id}. Trạng thái: ${ticketDetail.status}. Check-in: ${ticketDetail.check_in_status}`

            enrichedData.additionalInfo = {
              event_id: ticketDetail.event_id,
              event_name: eventName, // ✅ THÊM: Include event name
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

// ✅ THÊM: Build aggregated context function
function buildAggregatedContext (contextData, detectedFilters) {
  if (contextData.length === 0) {
    return {
      prompt: 'Không có thông tin liên quan trong cơ sở dữ liệu.',
      summaryInfo: null
    }
  }

  const summaryInfo = createSummaryInfo(contextData)

  let prompt = `Dựa trên thông tin tổng hợp từ hệ thống NFT Event Platform`

  if (detectedFilters.length > 0) {
    prompt += ` (tìm kiếm trong: ${detectedFilters.join(', ')})`
  }

  prompt += ':\n\n'

  // Tạo summary thay vì liệt kê chi tiết
  prompt += `Tổng cộng: ${summaryInfo.total_events} sự kiện, ${summaryInfo.total_tickets} vé\n`
  prompt += `- Sự kiện đang mở bán: ${summaryInfo.active_events}\n`
  prompt += `- Vé đã bán: ${summaryInfo.sold_tickets}\n`

  if (summaryInfo.sample_items.length > 0) {
    prompt += `- Ví dụ: ${summaryInfo.sample_items.join(', ')}\n`
  }

  prompt +=
    '\nHãy trả lời câu hỏi một cách tổng quan và đưa ra số liệu cụ thể. '
  prompt +=
    'Nếu có quá nhiều kết quả, hãy nhóm theo loại và đưa ra ví dụ tiêu biểu.'

  return { prompt, summaryInfo }
}

// ✅ THÊM: Build detailed context function
function buildDetailedContext (contextData, detectedFilters) {
  if (contextData.length === 0) {
    return {
      prompt: 'Không có thông tin liên quan trong cơ sở dữ liệu.',
      summaryInfo: null
    }
  }

  const summaryInfo = createSummaryInfo(contextData)

  let prompt = `Dựa trên thông tin sau từ hệ thống NFT Event Platform`

  if (detectedFilters.length > 0) {
    prompt += ` (tìm kiếm trong: ${detectedFilters.join(', ')})`
  }

  prompt += ':\n\n'

  contextData.forEach((item, index) => {
    prompt += `${index + 1}. ${item.type.toUpperCase()}: ${item.title}\n`
    prompt += `   ${item.content}\n\n`
  })

  prompt +=
    'Hãy trả lời câu hỏi dựa trên thông tin trên một cách chính xác và hữu ích. '
  prompt +=
    'Nếu thông tin không đầy đủ để trả lời, hãy nói rõ điều đó và đưa ra gợi ý.'

  return { prompt, summaryInfo }
}

// ✅ CẬP NHẬT: Export new functions
module.exports = {
  searchSimilarContent,
  buildAggregatedContext,
  buildDetailedContext,
  createSummaryInfo,
  truncateContext
}
