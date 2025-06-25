const mongoose = require('mongoose')

const chatHistorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    message: { type: String, required: true },
    response: { type: String, required: true },
    // ✅ FIX: Sửa sources schema để match với data structure
    sources: [
      {
        _id: false, // Disable mongoose _id for subdocuments
        type: { type: String, required: true }, // 'event', 'ticket', 'user'
        id: { type: String, required: true }, // ID của record
        title: { type: String, required: true }, // Title/name
        content: { type: String, default: '' }, // Content description
        score: { type: Number, default: 0 } // Relevance score
      }
    ],
    detectedFilters: [String], // Auto-detected filters
    confidence: { type: Number, default: 0.8 },
    createdAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true
  }
)

// Indexes for performance
chatHistorySchema.index({ userId: 1, createdAt: -1 })
chatHistorySchema.index({ sessionId: 1, createdAt: -1 })

const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema)

async function saveChatMessage (chatData) {
  try {
    console.log('Saving chat message with data:', {
      id: chatData.id,
      userId: chatData.userId,
      sourcesCount: chatData.sources?.length || 0,
      sourcesStructure: chatData.sources?.[0]
        ? Object.keys(chatData.sources[0])
        : 'no sources'
    })

    const chatHistory = new ChatHistory(chatData)
    await chatHistory.save()
    console.log(`ChatHistory saved successfully: ${chatData.id}`)
    return chatHistory
  } catch (error) {
    console.error('Error saving chat history:', error)

    // ✅ FALLBACK: Save without sources if schema error
    if (error.name === 'ValidationError' && error.message.includes('sources')) {
      console.warn(
        'Attempting to save chat history without sources due to validation error'
      )
      try {
        const fallbackData = { ...chatData, sources: [] }
        const fallbackHistory = new ChatHistory(fallbackData)
        await fallbackHistory.save()
        console.log(`ChatHistory saved without sources: ${chatData.id}`)
        return fallbackHistory
      } catch (fallbackError) {
        console.error('Fallback save also failed:', fallbackError)
        throw fallbackError
      }
    }
    throw error
  }
}

async function GetChatHistory (call, callback) {
  try {
    const { getChatHistory } = require('../models/ChatHistory')
    const { user_id, session_id, limit } = call.request

    const messages = await getChatHistory(user_id, session_id, limit || 50)

    callback(null, {
      messages: messages.map(msg => ({
        id: msg.id,
        user_id: msg.userId,
        session_id: msg.sessionId,
        message: msg.message,
        response: msg.response,
        timestamp: Math.floor(new Date(msg.createdAt).getTime() / 1000),
        detected_filters: msg.detectedFilters || [] // ✅ Include detected filters
      }))
    })
  } catch (error) {
    console.error('ChatbotService: GetChatHistory error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get chat history'
    })
  }
}

module.exports = {
  ChatHistory,
  saveChatMessage,
  getChatHistory
}
