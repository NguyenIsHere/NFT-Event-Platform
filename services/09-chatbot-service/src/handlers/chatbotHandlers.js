const grpc = require('@grpc/grpc-js')
const { generateResponse } = require('../services/geminiService')
const { searchSimilarContent } = require('../services/ragService')
const { saveChatMessage } = require('../models/ChatHistory')
const { detectIntent } = require('../services/intentDetectionService')
const { v4: uuidv4 } = require('uuid')

async function Chat (call, callback) {
  const { message, user_id, session_id, context_filters } = call.request

  console.log(`ChatbotService: Chat request from user ${user_id}: ${message}`)

  try {
    // 1. Auto-detect intent if no context_filters provided
    let finalContextFilters = context_filters

    if (!context_filters || context_filters.length === 0) {
      console.log('No context filters provided, auto-detecting intent...')
      const intentResult = await detectIntent(message)
      finalContextFilters = intentResult.filters

      console.log(
        `Auto-detected filters: [${finalContextFilters.join(
          ', '
        )}] with confidence: ${intentResult.confidence.toFixed(2)}`
      )
    } else {
      console.log(`Using provided filters: [${context_filters.join(', ')}]`)
    }

    // 2. Search for relevant context using RAG with detected filters
    const contextData = await searchSimilarContent(
      message,
      finalContextFilters,
      5
    )

    // 3. Build enhanced context prompt
    const contextPrompt = buildContextPrompt(contextData, finalContextFilters)

    // 4. Generate response using Gemini
    const response = await generateResponse(message, contextPrompt)

    // 5. Save chat history
    const chatId = uuidv4()
    const actualSessionId = session_id || chatId

    await saveChatMessage({
      id: chatId,
      userId: user_id,
      sessionId: actualSessionId,
      message,
      response: response.text,
      sources: contextData,
      detectedFilters: finalContextFilters // Save detected filters for analytics
    })

    // 6. Return response with detected filters info
    callback(null, {
      response: response.text,
      session_id: actualSessionId,
      sources: contextData.map(item => ({
        type: item.type,
        id: item.id,
        title: item.title,
        relevance_score: item.score
      })),
      confidence_score: response.confidence || 0.8,
      detected_filters: finalContextFilters // ✅ Trả về filters đã detect
    })
  } catch (error) {
    console.error('ChatbotService: Chat error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to process chat request'
    })
  }
}

function buildContextPrompt (contextData, detectedFilters) {
  if (!contextData || contextData.length === 0) {
    const filterText =
      detectedFilters.length > 0 ? ` về ${detectedFilters.join(', ')}` : ''
    return `Không có thông tin liên quan${filterText} trong cơ sở dữ liệu.`
  }

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

  return prompt
}

function buildContextPrompt (contextData) {
  if (!contextData || contextData.length === 0) {
    return 'Không có thông tin liên quan trong cơ sở dữ liệu.'
  }

  let prompt = 'Dựa trên thông tin sau từ hệ thống NFT Event Platform:\n\n'

  contextData.forEach((item, index) => {
    prompt += `${index + 1}. ${item.type.toUpperCase()}: ${item.title}\n`
    prompt += `   ${item.content}\n\n`
  })

  prompt +=
    'Hãy trả lời câu hỏi dựa trên thông tin trên. Nếu không có thông tin liên quan, hãy thông báo rằng bạn không tìm thấy thông tin.'

  return prompt
}

async function IndexData (call, callback) {
  const { data_type, force_reindex } = call.request

  try {
    const { indexExistingData } = require('../services/dataIndexer')
    const result = await indexExistingData(data_type, force_reindex)

    callback(null, {
      success: true,
      message: `Successfully indexed ${data_type}`,
      indexed_count: result.count
    })
  } catch (error) {
    console.error('ChatbotService: IndexData error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to index data'
    })
  }
}

async function GetChatHistory (call, callback) {
  try {
    const { getChatHistory } = require('../models/ChatHistory')
    const { user_id, session_id, limit } = call.request

    console.log(
      `🔍 GetChatHistory called for user: ${user_id}, session: ${session_id}`
    )

    // ✅ FIX: Validate required fields
    if (!user_id || typeof user_id !== 'string' || user_id.trim() === '') {
      console.error('❌ Invalid user_id:', user_id)
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'user_id is required and must be a non-empty string'
      })
    }

    const messages = await getChatHistory(user_id, session_id, limit || 50)

    console.log(`✅ Found ${messages.length} chat messages for user ${user_id}`)

    // ✅ FIX: Always return valid response, even if empty
    const response = {
      messages: messages.map(msg => ({
        id: msg.id,
        user_id: msg.userId,
        session_id: msg.sessionId,
        message: msg.message,
        response: msg.response,
        timestamp: Math.floor(new Date(msg.createdAt).getTime() / 1000),
        detected_filters: msg.detectedFilters || []
      }))
    }

    console.log(`🔍 Returning response:`, {
      messageCount: response.messages.length,
      firstMessage: response.messages[0]
        ? {
            id: response.messages[0].id,
            timestamp: response.messages[0].timestamp
          }
        : 'No messages'
    })

    callback(null, response)
  } catch (error) {
    console.error('❌ ChatbotService: GetChatHistory error:', error)

    // ✅ FIX: Return empty array on error instead of failing
    callback(null, { messages: [] })
  }
}

module.exports = {
  Chat,
  IndexData,
  GetChatHistory
}
