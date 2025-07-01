const { generateEmbedding } = require('./embeddingService')

const INTENT_PATTERNS = {
  event: [
    'sự kiện',
    'event',
    'buổi',
    'chương trình',
    'hoạt động',
    'tổ chức',
    'diễn ra',
    'concert',
    'hội thảo',
    'workshop',
    'festival',
    'triển lãm',
    'show',
    'lịch trình',
    'thời gian',
    'địa điểm',
    'location',
    'venue',
    'bao nhiêu sự kiện',
    'có sự kiện nào',
    'danh sách sự kiện',
    'sự kiện gì',
    'organizer',
    'người tổ chức',
    'trạng thái sự kiện'
  ],

  ticket: [
    'vé',
    'ticket',
    'mua',
    'bán',
    'đặt',
    'booking',
    'giá',
    'price',
    'loại vé',
    'ticket type',
    'số lượng',
    'quantity',
    'available',
    'còn vé',
    'hết vé',
    'sold out',
    'đã bán',
    'chỗ ngồi',
    'seat',
    'thanh toán',
    'payment',
    'mua vé',
    'đặt vé',
    // ✅ Check-in patterns
    'check-in',
    'check in',
    'checkin',
    'đã check',
    'đã vào',
    'đã tham dự',
    'đã tham gia',
    'attendance',
    'tham dự',
    'vào sự kiện',
    'quét vé',
    'scan ticket',
    'kiểm tra vé',
    'xác nhận vé'
  ],

  user: [
    'người dùng',
    'user',
    'tài khoản',
    'account',
    'đăng ký',
    'register',
    'thành viên',
    'member',
    'profile',
    'hồ sơ',
    'organizer',
    'admin'
  ]
}

// ✅ Enhanced status patterns for check-in queries
const STATUS_PATTERNS = [
  'trạng thái',
  'status',
  'đã',
  'already',
  'completed',
  'finished',
  'pending',
  'processing',
  'check-in',
  'checked in',
  'đã vào',
  'đã tham dự',
  'active',
  'hoạt động',
  'minted',
  'confirmed'
]

// Location patterns
const LOCATION_PATTERNS = [
  'ở đâu',
  'where',
  'tại',
  'at',
  'location',
  'địa điểm',
  'venue',
  'nơi'
]

// Time patterns
const TIME_PATTERNS = [
  'khi nào',
  'when',
  'thời gian',
  'time',
  'ngày',
  'date',
  'giờ',
  'hour',
  'bắt đầu',
  'start',
  'kết thúc',
  'end',
  'diễn ra',
  'happen'
]

// Count/quantity patterns
const COUNT_PATTERNS = [
  'bao nhiêu',
  'how many',
  'có mấy',
  'số lượng',
  'count',
  'total'
]

async function detectIntent (message) {
  const lowerMessage = message.toLowerCase()
  const detectedFilters = []
  const detectedIntents = {
    isLocationQuery: false,
    isTimeQuery: false,
    isCountQuery: false,
    isAvailabilityQuery: false,
    isStatusQuery: false // ✅ THÊM: Status query detection
  }

  // 1. Detect content types based on keywords
  for (const [type, keywords] of Object.entries(INTENT_PATTERNS)) {
    const hasKeyword = keywords.some(keyword =>
      lowerMessage.includes(keyword.toLowerCase())
    )

    if (hasKeyword) {
      detectedFilters.push(type)
    }
  }

  // 2. Detect query types
  detectedIntents.isLocationQuery = LOCATION_PATTERNS.some(pattern =>
    lowerMessage.includes(pattern.toLowerCase())
  )

  detectedIntents.isTimeQuery = TIME_PATTERNS.some(pattern =>
    lowerMessage.includes(pattern.toLowerCase())
  )

  detectedIntents.isCountQuery = COUNT_PATTERNS.some(pattern =>
    lowerMessage.includes(pattern.toLowerCase())
  )

  detectedIntents.isAvailabilityQuery = [
    'còn',
    'available',
    'hết',
    'sold out',
    'có thể',
    'can'
  ].some(pattern => lowerMessage.includes(pattern.toLowerCase()))

  // ✅ THÊM: Status query detection
  detectedIntents.isStatusQuery = STATUS_PATTERNS.some(pattern =>
    lowerMessage.includes(pattern.toLowerCase())
  )

  // 3. Smart defaults based on context
  if (detectedFilters.length === 0) {
    // Nếu không detect được gì, ưu tiên events
    if (detectedIntents.isLocationQuery || detectedIntents.isTimeQuery) {
      detectedFilters.push('event')
    } else if (detectedIntents.isCountQuery) {
      // "Bao nhiêu" có thể là events hoặc tickets
      detectedFilters.push('event', 'ticket')
    } else {
      // Default: search tất cả (trừ users vì privacy)
      detectedFilters.push('event', 'ticket')
    }
  }

  // 4. Remove users từ default search (privacy)
  if (detectedFilters.includes('user') && detectedFilters.length > 1) {
    detectedFilters.splice(detectedFilters.indexOf('user'), 1)
  }

  console.log(
    `Intent Detection: "${message}" -> filters: [${detectedFilters.join(
      ', '
    )}], intents:`,
    detectedIntents
  )

  return {
    filters: detectedFilters,
    intents: detectedIntents,
    confidence: calculateIntentConfidence(lowerMessage, detectedFilters)
  }
}

function calculateIntentConfidence (message, detectedFilters) {
  let totalMatches = 0
  let totalKeywords = 0

  for (const [type, keywords] of Object.entries(INTENT_PATTERNS)) {
    if (detectedFilters.includes(type)) {
      const matches = keywords.filter(keyword =>
        message.includes(keyword.toLowerCase())
      ).length
      totalMatches += matches
      totalKeywords += keywords.length
    }
  }

  return totalKeywords > 0
    ? Math.min((totalMatches / totalKeywords) * 2, 1)
    : 0.5
}

// Advanced intent detection using embeddings (optional, more advanced)
async function detectIntentWithEmbeddings (message) {
  try {
    // Tạo embedding cho câu hỏi
    const messageEmbedding = await generateEmbedding(message)

    // Predefined intent embeddings (có thể cache)
    const intentExamples = {
      event: [
        'Có sự kiện nào diễn ra không?',
        'Sự kiện ở đâu?',
        'Khi nào có concert?',
        'Danh sách các buổi hòa nhạc'
      ],
      ticket: [
        'Mua vé ở đâu?',
        'Giá vé bao nhiêu?',
        'Còn vé không?',
        'Loại vé nào có sẵn?'
      ]
    }

    // So sánh similarity (simplified version)
    let bestMatch = { type: 'event', similarity: 0 }

    // This would require actual similarity calculation
    // For now, fallback to keyword-based detection
    return await detectIntent(message)
  } catch (error) {
    console.warn(
      'Advanced intent detection failed, falling back to keyword-based:',
      error.message
    )
    return await detectIntent(message)
  }
}

module.exports = {
  detectIntent,
  detectIntentWithEmbeddings,
  INTENT_PATTERNS
}
