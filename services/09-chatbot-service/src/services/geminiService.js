const axios = require('axios')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_API_URL = process.env.GEMINI_API_URL

if (!GEMINI_API_KEY) {
  console.error('FATAL ERROR: GEMINI_API_KEY is not defined')
  process.exit(1)
}

async function generateResponse (userMessage, contextPrompt) {
  try {
    const systemPrompt = `Bạn là một chatbot hỗ trợ cho NFT Event Platform. 
    Bạn giúp người dùng tìm hiểu về các sự kiện, vé, và thông tin liên quan.
    Hãy trả lời bằng tiếng Việt một cách thân thiện và chính xác.
    
    ${contextPrompt}
    
    Câu hỏi của người dùng: ${userMessage}`

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: systemPrompt
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 1024
      }
    }

    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    )

    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return {
        text: response.data.candidates[0].content.parts[0].text,
        confidence: calculateConfidence(response.data)
      }
    } else {
      throw new Error('Invalid response from Gemini API')
    }
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message)

    if (error.response?.status === 429) {
      throw new Error('API rate limit exceeded. Please try again later.')
    } else if (error.response?.status === 401) {
      throw new Error('Invalid Gemini API key.')
    } else {
      throw new Error('Failed to generate response. Please try again.')
    }
  }
}

function calculateConfidence (apiResponse) {
  // Tính toán confidence score dựa trên response
  // Có thể dựa vào độ dài response, presence của citation, etc.
  if (apiResponse.candidates?.[0]?.finishReason === 'STOP') {
    return 0.8
  }
  return 0.6
}

module.exports = {
  generateResponse
}
