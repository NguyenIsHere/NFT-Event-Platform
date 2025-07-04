const axios = require('axios')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_API_URL = process.env.GEMINI_API_URL

if (!GEMINI_API_KEY) {
  console.error('FATAL ERROR: GEMINI_API_KEY is not defined')
  process.exit(1)
}

async function generateResponse (
  userMessage,
  contextPrompt,
  queryType = 'SPECIFIC'
) {
  try {
    // Adaptive system prompt based on query type
    let systemPrompt = `Bạn là một chatbot hỗ trợ cho NFT Event Platform. 
    Bạn giúp người dùng tìm hiểu về các sự kiện, vé, và thông tin liên quan.`

    if (queryType === 'LISTING') {
      systemPrompt += `
      
      QUY TẮC TRẢ LỜI CHO CÂU HỎI TỔNG QUAN:
      - Khi được hỏi về danh sách/những gì: trả lời bằng số liệu tổng quan
      - Nhóm kết quả theo loại (sự kiện, vé, etc.)
      - Đưa ra ví dụ tiêu biểu thay vì liệt kê tất cả
      - Sử dụng format: "Có X sự kiện, Y vé. Ví dụ: A, B, C"
      - Trả lời ngắn gọn và trực tiếp
      - KHÔNG sử dụng định dạng Markdown
      - KHÔNG viết dài dòng hay lặp lại thông tin
      - LUÔN sử dụng TÊN SỰ KIỆN thay vì ID sự kiện
      - Chuyển đổi trạng thái technical thành ngôn ngữ thân thiện (VD: CHECKED_IN -> đã check-in)
      - Không bao gồm các id hay giá trị trực tiếp từ dữ liệu vào câu trả lời`
    } else {
      systemPrompt += `
      
      QUY TẮC TRẢ LỜI CHO CÂU HỎI CỤ THỂ:
      - Trả lời chi tiết và chính xác
      - Đi thẳng vào vấn đề
      - Trả lời bằng tiếng Việt một cách thân thiện và không quá cụt lủn
      - KHÔNG sử dụng định dạng Markdown (*, **, #, -, etc.)
      - LUÔN sử dụng TÊN SỰ KIỆN thay vì ID sự kiện
      - Chuyển đổi trạng thái technical thành ngôn ngữ thân thiện:
        * CHECKED_IN -> đã check-in
        * NOT_CHECKED_IN -> chưa check-in
        * PAID -> đã thanh toán
        * PENDING -> đang xử lý
        * ACTIVE -> đang hoạt động
        * ENDED -> đã kết thúc
      - KHÔNG viết dài dòng hay lặp lại thông tin
      - Nếu không có dữ liệu, chỉ nói "Không tìm thấy" thay vì giải thích dài
      - Không sử dụng emoji hay ký tự đặc biệt
      - KHÔNG sử dụng từ ngữ như "tôi nghĩ", "có thể", "có lẽ" - chỉ nói sự thật`
    }

    systemPrompt += `
    
    QUY TẮC ĐẶC BIỆT VỀ TÊN SỰ KIỆN:
    - Khi nhắc đến vé hoặc check-in, LUÔN dùng tên sự kiện nếu có
    - Nếu trong dữ liệu có cả event_id và event_name, ưu tiên event_name
    - Ví dụ: "Bạn đã check-in tại sự kiện Rock Concert 2024" thay vì "Bạn đã check-in tại sự kiện event_123"
    - Nếu không có tên sự kiện, hãy dùng mô tả thân thiện như "sự kiện này" hoặc "sự kiện đó"
    
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
        maxOutputTokens: queryType === 'LISTING' ? 1024 : 2048, // Ngắn hơn cho listing queries
        candidateCount: 1,
        stopSequences: ['\n\n\n']
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
