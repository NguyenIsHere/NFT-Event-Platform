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
    
    QUY TẮC TRẢ LỜI:
    - Trả lời bằng tiếng Việt một cách NGẮN GỌN và TRỰC TIẾP
    - KHÔNG sử dụng định dạng Markdown (*, **, #, -, etc.)
    - KHÔNG viết dài dòng hay lặp lại thông tin
    - ĐI THẲNG VÀO VẤN ĐỀ và trả lời cụ thể
    - Nếu không có dữ liệu, chỉ nói "Không tìm thấy" thay vì giải thích dài
    - Không sử dụng emoji hay ký tự đặc biệt
    - KHÔNG sử dụng từ ngữ như "tôi nghĩ", "có thể", "có lẽ" - chỉ nói sự thật
    - KHÔNG sử dụng từ ngữ như "tôi thấy", "theo tôi", "theo dữ liệu" - chỉ nói thông tin
    - KHÔNG sử dụng từ ngữ như "tôi đã kiểm tra", "sau khi tìm kiếm" - chỉ nói kết quả
    - KHÔNG bao gồm các thông tin như id, timestamp, hay metadata không cần thiết

    VÍ DỤ:
    - Thay vì: "Sau khi tìm kiếm trên hệ thống, tôi thấy có 3 sự kiện..."
    - Hãy nói: "Có 3 sự kiện âm nhạc nhưng tất cả đã kết thúc."
    
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
        temperature: 0.3, // Giảm từ 0.7 để ít sáng tạo hơn, tập trung vào sự thật
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 300, // Giảm từ 1024 để bắt buộc trả lời ngắn
        candidateCount: 1,
        stopSequences: ['\n\n\n'] // Dừng khi có quá nhiều dòng trống
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
