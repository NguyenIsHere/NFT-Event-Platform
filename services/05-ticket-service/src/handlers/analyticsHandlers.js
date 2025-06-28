// services/05-ticket-service/src/handlers/analyticsHandlers.js

const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const { Purchase } = require('../models/Purchase')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')

// Dashboard tổng quan cho 1 event
// ✅ ENHANCED: Dashboard với Purchase Analytics
async function GetEventDashboard (call, callback) {
  const { event_id, date_range } = call.request

  try {
    const now = new Date()
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : now

    console.log('🔍 Dashboard analytics query:', {
      event_id,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    })

    // 1. ✅ REAL-TIME: Get all ticket types for this event
    const ticketTypes = await TicketType.find({ eventId: event_id })
    const ticketTypeIds = ticketTypes.map(tt => tt._id.toString())

    console.log('📋 Found ticket types:', ticketTypeIds.length)

    // 2. ✅ ENHANCED: Purchase Analytics (primary source)
    const purchaseStats = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $lookup: {
          from: 'tickettypes',
          localField: 'ticketTypeId',
          foreignField: '_id',
          as: 'ticketType'
        }
      },
      {
        $addFields: {
          ticketType: { $arrayElemAt: ['$ticketType', 0] }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          totalValue: {
            $sum: {
              $multiply: ['$quantity', { $toLong: '$ticketType.priceWei' }]
            }
          }
        }
      }
    ])

    console.log('💰 Purchase stats:', purchaseStats)

    // 3. ✅ REAL-TIME: Ticket Stats (current state)
    const ticketStats = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ])

    console.log('🎫 Ticket stats:', ticketStats)

    // 4. ✅ REAL-TIME: Purchase Conversion Analytics
    const conversionStats = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          totalInitiated: { $sum: 1 },
          totalConfirmed: {
            $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] }
          },
          totalExpired: {
            $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] }
          },
          totalFailed: {
            $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] }
          },
          avgCompletionTime: {
            $avg: {
              $cond: [
                { $eq: ['$status', 'CONFIRMED'] },
                { $subtract: ['$updatedAt', '$createdAt'] },
                null
              ]
            }
          }
        }
      }
    ])

    const conversionData = conversionStats[0] || {
      totalInitiated: 0,
      totalConfirmed: 0,
      totalExpired: 0,
      totalFailed: 0,
      avgCompletionTime: 0
    }

    console.log('📊 Conversion stats:', conversionData)

    // 5. ✅ ENHANCED: Daily Sales với Purchase data
    const dailySales = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $lookup: {
          from: 'tickettypes',
          localField: 'ticketTypeId',
          foreignField: '_id',
          as: 'ticketType'
        }
      },
      {
        $addFields: {
          ticketType: { $arrayElemAt: ['$ticketType', 0] }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
            status: '$status'
          },
          purchaseCount: { $sum: 1 },
          ticketsSold: {
            $sum: {
              $cond: [{ $eq: ['$status', 'CONFIRMED'] }, '$quantity', 0]
            }
          },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'CONFIRMED'] },
                {
                  $multiply: ['$quantity', { $toLong: '$ticketType.priceWei' }]
                },
                0
              ]
            }
          }
        }
      },
      {
        $group: {
          _id: {
            year: '$_id.year',
            month: '$_id.month',
            day: '$_id.day'
          },
          totalPurchases: { $sum: '$purchaseCount' },
          confirmedPurchases: {
            $sum: {
              $cond: [
                { $eq: ['$_id.status', 'CONFIRMED'] },
                '$purchaseCount',
                0
              ]
            }
          },
          ticketsSold: { $sum: '$ticketsSold' },
          revenue: { $sum: '$revenue' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ])

    console.log('📈 Daily sales:', dailySales.slice(0, 3))

    // 6. ✅ REAL-TIME: Check-in Statistics
    const checkinStats = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          status: TICKET_STATUS_ENUM[4] // MINTED only
        }
      },
      {
        $group: {
          _id: '$checkInStatus',
          count: { $sum: 1 }
        }
      }
    ])

    console.log('✅ Check-in stats:', checkinStats)

    // 7. ✅ NEW: Purchase Funnel Steps
    const funnelSteps = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgCompletionTime: {
            $avg: {
              $cond: [
                { $eq: ['$status', 'CONFIRMED'] },
                { $subtract: ['$updatedAt', '$createdAt'] },
                null
              ]
            }
          }
        }
      }
    ])

    // 8. ✅ FIX: Enhanced Revenue Calculation with better error handling
    let totalRevenue = 0
    let totalTicketsFromPurchases = 0

    const confirmedPurchases = purchaseStats.find(p => p._id === 'CONFIRMED')

    if (confirmedPurchases && confirmedPurchases.totalValue) {
      totalRevenue = confirmedPurchases.totalValue
      totalTicketsFromPurchases = confirmedPurchases.totalQuantity
      console.log('💰 Revenue from confirmed purchases:', {
        totalRevenue,
        totalTickets: totalTicketsFromPurchases,
        purchaseCount: confirmedPurchases.count
      })
    } else {
      // ✅ FALLBACK: Calculate from ticket types and confirmed transactions
      console.log(
        '⚠️ No confirmed purchases with totalValue, calculating fallback...'
      )

      const fallbackRevenue = await Ticket.aggregate([
        {
          $match: {
            eventId: event_id,
            status: TICKET_STATUS_ENUM[4], // MINTED
            createdAt: { $gte: startDate, $lte: endDate }
          }
        },
        {
          $lookup: {
            from: 'tickettypes',
            localField: 'ticketTypeId',
            foreignField: '_id',
            as: 'ticketType'
          }
        },
        {
          $addFields: {
            ticketType: { $arrayElemAt: ['$ticketType', 0] }
          }
        },
        {
          $group: {
            _id: null,
            totalTickets: { $sum: 1 },
            totalRevenue: {
              $sum: { $toLong: '$ticketType.priceWei' }
            }
          }
        }
      ])

      if (fallbackRevenue[0]) {
        totalRevenue = fallbackRevenue[0].totalRevenue
        totalTicketsFromPurchases = fallbackRevenue[0].totalTickets
        console.log('💰 Fallback revenue calculation:', {
          totalRevenue,
          totalTickets: totalTicketsFromPurchases
        })
      }
    }

    const platformFee = Math.floor(totalRevenue * 0.05) // 5% platform fee
    const organizerRevenue = totalRevenue - platformFee

    // Format response với enhanced analytics
    const dashboard = {
      event_id,
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      // ✅ ENHANCED: Ticket summary
      ticket_summary: {
        total_tickets: ticketStats.reduce((sum, stat) => sum + stat.count, 0),
        by_status: ticketStats.map(stat => ({
          status: stat._id,
          count: stat.count
        }))
      },
      // ✅ NEW: Purchase summary với better data
      purchase_summary: {
        total_purchases: purchaseStats.reduce(
          (sum, stat) => sum + stat.count,
          0
        ),
        by_status: purchaseStats.map(stat => ({
          status: stat._id,
          count: stat.count,
          total_quantity: stat.totalQuantity || 0,
          total_value_wei: (stat.totalValue || 0).toString()
        })),
        conversion_rate:
          conversionData.totalInitiated > 0
            ? (
                (conversionData.totalConfirmed /
                  conversionData.totalInitiated) *
                100
              ).toFixed(2)
            : '0.00',
        abandonment_rate:
          conversionData.totalInitiated > 0
            ? (
                ((conversionData.totalExpired + conversionData.totalFailed) /
                  conversionData.totalInitiated) *
                100
              ).toFixed(2)
            : '0.00'
      },
      // ✅ FIX: Revenue summary với correct data format
      revenue_summary: {
        total_revenue_wei: totalRevenue.toString(),
        platform_fees_wei: platformFee.toString(),
        organizer_revenue_wei: organizerRevenue.toString(),
        transaction_count: confirmedPurchases
          ? confirmedPurchases.count
          : ticketStats.find(t => t._id === TICKET_STATUS_ENUM[4])?.count || 0
      },
      // ✅ EXISTING: Check-in summary
      checkin_summary: {
        total_minted: checkinStats.reduce((sum, stat) => sum + stat.count, 0),
        by_status: checkinStats.map(stat => ({
          status: stat._id || 'NOT_CHECKED_IN',
          count: stat.count
        }))
      },
      // ✅ ENHANCED: Daily trends với purchase data
      daily_trends: dailySales.map(day => ({
        date: `${day._id.year}-${day._id.month
          .toString()
          .padStart(2, '0')}-${day._id.day.toString().padStart(2, '0')}`,
        tickets_sold: day.ticketsSold,
        purchase_count: day.totalPurchases,
        revenue_wei: day.revenue.toString()
      })),
      // ✅ NEW: Purchase funnel
      purchase_funnel: funnelSteps.map(step => ({
        status: step._id,
        count: step.count,
        avg_completion_time_ms: Math.floor(step.avgCompletionTime || 0)
      }))
    }

    console.log('✅ Dashboard response with revenue:', {
      totalPurchases: dashboard.purchase_summary.total_purchases,
      totalTickets: dashboard.ticket_summary.total_tickets,
      totalRevenueWei: dashboard.revenue_summary.total_revenue_wei,
      organizerRevenueWei: dashboard.revenue_summary.organizer_revenue_wei,
      platformFeesWei: dashboard.revenue_summary.platform_fees_wei,
      conversionRate: dashboard.purchase_summary.conversion_rate
    })

    callback(null, dashboard)
  } catch (error) {
    console.error('❌ Analytics: GetEventDashboard error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event dashboard'
    })
  }
}

// ✅ NEW: Purchase Analytics RPC
async function GetPurchaseAnalytics (call, callback) {
  const { event_id, time_period } = call.request

  try {
    console.log('🔍 GetPurchaseAnalytics:', { event_id, time_period })

    const now = new Date()
    let startDate

    switch (time_period) {
      case 'TODAY':
        startDate = new Date(now.setHours(0, 0, 0, 0))
        break
      case 'WEEK':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'MONTH':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        break
      default:
        startDate = new Date(0) // All time
    }

    // Get ticket types for this event
    const ticketTypes = await TicketType.find({ eventId: event_id })
    const ticketTypeIds = ticketTypes.map(tt => tt._id.toString())

    // Purchase flow analytics by hour
    const purchaseFlow = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          createdAt: { $gte: startDate }
        }
      },
      {
        $addFields: {
          hour: { $hour: { date: '$createdAt', timezone: 'Asia/Ho_Chi_Minh' } }
        }
      },
      {
        $group: {
          _id: {
            hour: '$hour',
            status: '$status'
          },
          count: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' }
        }
      },
      { $sort: { '_id.hour': 1 } }
    ])

    // Average purchase metrics
    const avgPurchaseMetrics = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          status: 'CONFIRMED',
          createdAt: { $gte: startDate }
        }
      },
      {
        $lookup: {
          from: 'tickettypes',
          localField: 'ticketTypeId',
          foreignField: '_id',
          as: 'ticketType'
        }
      },
      {
        $addFields: {
          ticketType: { $arrayElemAt: ['$ticketType', 0] }
        }
      },
      {
        $group: {
          _id: null,
          avgQuantity: { $avg: '$quantity' },
          avgValue: {
            $avg: {
              $multiply: ['$quantity', { $toLong: '$ticketType.priceWei' }]
            }
          }
        }
      }
    ])

    const response = {
      event_id,
      time_period: time_period || 'ALL',
      hourly_purchases: [],
      avg_purchase_quantity: avgPurchaseMetrics[0]?.avgQuantity || 0,
      avg_purchase_value_wei:
        avgPurchaseMetrics[0]?.avgValue?.toString() || '0',
      purchase_flow: purchaseFlow.map(flow => ({
        hour: flow._id.hour,
        status: flow._id.status,
        count: flow.count,
        total_quantity: flow.totalQuantity
      }))
    }

    // Generate hourly purchases summary
    const hourlyMap = new Map()
    purchaseFlow.forEach(flow => {
      const hour = flow._id.hour
      if (!hourlyMap.has(hour)) {
        hourlyMap.set(hour, { initiated_count: 0, confirmed_count: 0 })
      }
      const hourData = hourlyMap.get(hour)
      if (flow._id.status === 'INITIATED') {
        hourData.initiated_count += flow.count
      } else if (flow._id.status === 'CONFIRMED') {
        hourData.confirmed_count += flow.count
      }
    })

    response.hourly_purchases = Array.from(hourlyMap.entries())
      .map(([hour, data]) => ({
        hour,
        initiated_count: data.initiated_count,
        confirmed_count: data.confirmed_count
      }))
      .sort((a, b) => a.hour - b.hour)

    console.log('✅ Purchase analytics response:', {
      hourlyPurchasesCount: response.hourly_purchases.length,
      avgQuantity: response.avg_purchase_quantity,
      avgValue: response.avg_purchase_value_wei
    })

    callback(null, response)
  } catch (error) {
    console.error('❌ Analytics: GetPurchaseAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get purchase analytics'
    })
  }
}

// ✅ ENHANCED: Organizer Stats với Purchase data
async function GetOrganizerStats (call, callback) {
  const { organizer_id } = call.request

  try {
    console.log('🔍 GetOrganizerStats for:', organizer_id)

    // Get all events của organizer
    const eventServiceClient = require('../clients/eventServiceClient')
    const eventsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.ListEvents({ organizer_id }, (err, response) => {
        if (err) return reject(err)
        resolve(response)
      })
    })

    const eventIds = eventsResponse.events?.map(e => e.id) || []
    console.log('📋 Found events for organizer:', eventIds.length)

    if (eventIds.length === 0) {
      return callback(null, {
        organizer_id,
        total_events: 0,
        total_tickets_sold: 0,
        total_revenue_wei: '0',
        active_events: 0
      })
    }

    // Get all ticket types for these events
    const allTicketTypes = await TicketType.find({ eventId: { $in: eventIds } })
    const ticketTypeIds = allTicketTypes.map(tt => tt._id.toString())

    // ✅ REAL-TIME: Revenue from confirmed purchases
    const revenueStats = await Purchase.aggregate([
      {
        $match: {
          ticketTypeId: {
            $in: ticketTypeIds.map(id => new mongoose.Types.ObjectId(id))
          },
          status: 'CONFIRMED'
        }
      },
      {
        $lookup: {
          from: 'tickettypes',
          localField: 'ticketTypeId',
          foreignField: '_id',
          as: 'ticketType'
        }
      },
      {
        $addFields: {
          ticketType: { $arrayElemAt: ['$ticketType', 0] }
        }
      },
      {
        $group: {
          _id: null,
          totalTicketsSold: { $sum: '$quantity' },
          totalRevenue: {
            $sum: {
              $multiply: ['$quantity', { $toLong: '$ticketType.priceWei' }]
            }
          },
          uniqueEvents: { $addToSet: '$ticketType.eventId' }
        }
      }
    ])

    const stats = revenueStats[0] || {
      totalTicketsSold: 0,
      totalRevenue: 0,
      uniqueEvents: []
    }

    // Calculate organizer revenue (95% after platform fee)
    const organizerRevenue = Math.floor(stats.totalRevenue * 0.95)

    console.log('✅ Organizer stats:', {
      totalEvents: eventIds.length,
      totalTicketsSold: stats.totalTicketsSold,
      organizerRevenue
    })

    callback(null, {
      organizer_id,
      total_events: eventIds.length,
      total_tickets_sold: stats.totalTicketsSold,
      total_revenue_wei: organizerRevenue.toString(),
      active_events: stats.uniqueEvents.length
    })
  } catch (error) {
    console.error('❌ Analytics: GetOrganizerStats error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get organizer stats'
    })
  }
}

// Check-in analytics cho event staff
async function GetCheckinAnalytics (call, callback) {
  const { event_id, time_period } = call.request

  try {
    console.log(`🔍 GetCheckinAnalytics called:`, {
      event_id,
      time_period,
      timestamp: new Date().toISOString()
    })

    // ✅ FIX: Base query - chỉ lấy tickets đã minted và có check-in time
    const baseMatch = {
      eventId: event_id,
      status: TICKET_STATUS_ENUM[4], // MINTED
      checkInStatus: 'CHECKED_IN', // ✅ THÊM: Chỉ lấy tickets đã check-in
      checkInTime: { $exists: true, $ne: null } // ✅ THÊM: Phải có checkInTime
    }

    // ✅ FIX: Time range filtering
    if (time_period === 'TODAY') {
      const today = new Date()
      const startOfToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        0,
        0,
        0,
        0
      )
      const endOfToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        23,
        59,
        59,
        999
      )

      baseMatch.checkInTime = {
        $gte: startOfToday,
        $lte: endOfToday
      }

      console.log(`📅 TODAY filter applied:`, {
        startOfToday: startOfToday.toISOString(),
        endOfToday: endOfToday.toISOString(),
        currentTime: new Date().toISOString()
      })
    } else if (time_period === 'WEEK') {
      const today = new Date()
      const startOfWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
      baseMatch.checkInTime = { $gte: startOfWeek }
    }
    // For 'ALL' - no time filter

    console.log(`🔍 Base match query:`, JSON.stringify(baseMatch, null, 2))

    // ✅ FIX: Debug - count total matching tickets first
    const totalMatchingTickets = await Ticket.countDocuments(baseMatch)
    console.log(`📊 Total tickets matching criteria: ${totalMatchingTickets}`)

    // ✅ FIX: Hourly check-in trend với better aggregation
    const hourlyCheckins = await Ticket.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          checkInHour: {
            $hour: { date: '$checkInTime', timezone: 'Asia/Ho_Chi_Minh' }
          }
        }
      },
      {
        $group: {
          _id: '$checkInHour',
          count: { $sum: 1 },
          tickets: {
            $push: {
              // ✅ DEBUG: Collect ticket details
              id: '$_id',
              checkInTime: '$checkInTime'
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ])

    console.log(
      `📊 Hourly checkins aggregation result:`,
      JSON.stringify(hourlyCheckins, null, 2)
    )

    // ✅ FIX: Check-in by location với debugging
    const locationStats = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          checkInStatus: 'CHECKED_IN',
          checkInTime: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$checkInLocation',
          count: { $sum: 1 },
          tickets: {
            $push: {
              // ✅ DEBUG: Collect ticket details
              id: '$_id',
              checkInTime: '$checkInTime',
              location: '$checkInLocation'
            }
          }
        }
      }
    ])

    console.log(
      `📍 Location stats result:`,
      JSON.stringify(locationStats, null, 2)
    )

    // ✅ FIX: Summary statistics
    const summary = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          status: TICKET_STATUS_ENUM[4] // MINTED only
        }
      },
      {
        $group: {
          _id: '$checkInStatus',
          count: { $sum: 1 }
        }
      }
    ])

    console.log(`📋 Check-in summary:`, JSON.stringify(summary, null, 2))

    const response = {
      event_id,
      time_period: time_period || 'ALL',
      hourly_checkins: hourlyCheckins.map(h => ({
        hour: h._id,
        count: h.count
      })),
      location_breakdown: locationStats.map(l => ({
        location: l._id || 'Unknown',
        count: l.count
      })),
      summary: {
        total_checked_in: summary.find(s => s._id === 'CHECKED_IN')?.count || 0,
        total_not_checked_in:
          summary.find(s => s._id === 'NOT_CHECKED_IN')?.count || 0
      }
    }

    console.log(`✅ Final response:`, JSON.stringify(response, null, 2))

    callback(null, response)
  } catch (error) {
    console.error('❌ Analytics: GetCheckinAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get checkin analytics'
    })
  }
}

module.exports = {
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics,
  GetPurchaseAnalytics
}
