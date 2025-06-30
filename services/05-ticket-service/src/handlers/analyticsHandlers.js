// services/05-ticket-service/src/handlers/analyticsHandlers.js
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const {
  TransactionLog,
  TRANSACTION_TYPES
} = require('../models/TransactionLog')
const TransactionLogger = require('../utils/transactionLogger')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')

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

    // ✅ REPLACE: Purchase analytics with TransactionLog analytics
    const purchaseStats = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalQuantity: { $sum: { $toInt: '$metadata.quantity' } },
          totalAmountWei: {
            $sum: { $toLong: '$amountWei' }
          },
          totalPlatformFeeWei: {
            $sum: { $toLong: '$platformFeeWei' }
          },
          totalOrganizerAmountWei: {
            $sum: { $toLong: '$organizerAmountWei' }
          }
        }
      }
    ])

    // ✅ TICKET stats from Ticket collection (current state)
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

    // ✅ DAILY trends from TransactionLog
    const dailySales = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          ticketsSold: { $sum: { $toInt: '$metadata.quantity' } },
          transactionCount: { $sum: 1 },
          revenue: { $sum: { $toLong: '$amountWei' } }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ])

    // ✅ CALCULATE totals from confirmed transactions
    const confirmedPurchases = purchaseStats.find(p => p._id === 'CONFIRMED')
    const totalRevenue = confirmedPurchases?.totalAmountWei || 0
    const platformFee = confirmedPurchases?.totalPlatformFeeWei || 0
    const organizerRevenue = confirmedPurchases?.totalOrganizerAmountWei || 0

    // ✅ CONVERSION rate calculation
    const totalTransactions = purchaseStats.reduce(
      (sum, stat) => sum + stat.count,
      0
    )
    const confirmedTransactions = confirmedPurchases?.count || 0
    const conversionRate =
      totalTransactions > 0
        ? ((confirmedTransactions / totalTransactions) * 100).toFixed(2)
        : '0.00'

    const dashboard = {
      event_id,
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      ticket_summary: {
        total_tickets: ticketStats.reduce((sum, stat) => sum + stat.count, 0),
        by_status: ticketStats.map(stat => ({
          status: stat._id,
          count: stat.count
        }))
      },
      purchase_summary: {
        total_purchases: totalTransactions,
        by_status: purchaseStats.map(stat => ({
          status: stat._id,
          count: stat.count,
          total_quantity: stat.totalQuantity || 0,
          total_value_wei: (stat.totalAmountWei || 0).toString()
        })),
        conversion_rate: conversionRate
      },
      revenue_summary: {
        total_revenue_wei: totalRevenue.toString(),
        platform_fees_wei: platformFee.toString(),
        organizer_revenue_wei: organizerRevenue.toString(),
        transaction_count: confirmedTransactions
      },
      daily_trends: dailySales.map(day => ({
        date: `${day._id.year}-${day._id.month
          .toString()
          .padStart(2, '0')}-${day._id.day.toString().padStart(2, '0')}`,
        tickets_sold: day.ticketsSold,
        purchase_count: day.transactionCount,
        revenue_wei: day.revenue.toString()
      }))
    }

    callback(null, dashboard)
  } catch (error) {
    console.error('❌ GetEventDashboard error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event dashboard'
    })
  }
}

async function GetOrganizerStats (call, callback) {
  const { organizer_id } = call.request

  try {
    console.log('🔍 GetOrganizerStats for:', organizer_id)

    // Get all events của organizer
    const eventServiceClient = require('../clients/eventServiceClient')
    const eventsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.ListEvents(
        { organizer_id: organizer_id },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) reject(err)
          else resolve(res)
        }
      )
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

    // ❌ REMOVE: Purchase-based analytics
    // const allTicketTypes = await TicketType.find({ eventId: { $in: eventIds } })
    // const revenueStats = await Purchase.aggregate([...])

    // ✅ REPLACE: TransactionLog-based analytics
    const revenueStats = await TransactionLog.aggregate([
      {
        $match: {
          organizerId: organizer_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED'
        }
      },
      {
        $group: {
          _id: null,
          totalTicketsSold: {
            $sum: { $toInt: '$metadata.quantity' }
          },
          totalRevenue: {
            $sum: { $toLong: '$organizerAmountWei' }
          },
          uniqueEvents: { $addToSet: '$eventId' }
        }
      }
    ])

    const stats = revenueStats[0] || {
      totalTicketsSold: 0,
      totalRevenue: 0,
      uniqueEvents: []
    }

    console.log('✅ Organizer stats:', {
      totalEvents: eventIds.length,
      totalTicketsSold: stats.totalTicketsSold,
      totalRevenue: stats.totalRevenue
    })

    callback(null, {
      organizer_id,
      total_events: eventIds.length,
      total_tickets_sold: stats.totalTicketsSold,
      total_revenue_wei: stats.totalRevenue.toString(),
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

// ✅ NEW: Admin analytics function
async function GetAdminAnalytics (call, callback) {
  const { date_range, transaction_type } = call.request

  try {
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : new Date()

    // Get transaction logs based on TransactionLog model
    const filters = {
      fromDate: startDate,
      toDate: endDate,
      status: 'CONFIRMED'
    }

    if (transaction_type) {
      filters.type = transaction_type
    }

    const { logs } = await TransactionLogger.getTransactionLogs(filters)

    // Process logs for analytics
    const transactionSummary = {}
    const dailyTrends = {}
    const eventRevenue = {}

    logs.forEach(log => {
      // Transaction summary
      if (!transactionSummary[log.type]) {
        transactionSummary[log.type] = {
          count: 0,
          totalAmountWei: BigInt(0),
          totalPlatformFeeWei: BigInt(0),
          totalOrganizerAmountWei: BigInt(0)
        }
      }

      transactionSummary[log.type].count++
      transactionSummary[log.type].totalAmountWei += BigInt(
        log.amountWei || '0'
      )
      transactionSummary[log.type].totalPlatformFeeWei += BigInt(
        log.platformFeeWei || '0'
      )
      transactionSummary[log.type].totalOrganizerAmountWei += BigInt(
        log.organizerAmountWei || '0'
      )

      // Daily trends
      const dateKey = log.createdAt.toISOString().split('T')[0]
      const trendKey = `${dateKey}-${log.type}`

      if (!dailyTrends[trendKey]) {
        dailyTrends[trendKey] = {
          date: dateKey,
          type: log.type,
          count: 0,
          totalAmountWei: BigInt(0)
        }
      }

      dailyTrends[trendKey].count++
      dailyTrends[trendKey].totalAmountWei += BigInt(log.amountWei || '0')

      // Event revenue (only for ticket purchases)
      if (log.type === 'TICKET_PURCHASE' && log.eventId) {
        if (!eventRevenue[log.eventId]) {
          eventRevenue[log.eventId] = {
            eventId: log.eventId,
            ticketsSold: 0,
            totalRevenue: BigInt(0),
            organizerRevenue: BigInt(0),
            platformFees: BigInt(0)
          }
        }

        eventRevenue[log.eventId].ticketsSold += log.metadata?.quantity || 1
        eventRevenue[log.eventId].totalRevenue += BigInt(log.amountWei || '0')
        eventRevenue[log.eventId].organizerRevenue += BigInt(
          log.organizerAmountWei || '0'
        )
        eventRevenue[log.eventId].platformFees += BigInt(
          log.platformFeeWei || '0'
        )
      }
    })

    // Convert to response format
    const response = {
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      transaction_summary: Object.entries(transactionSummary).map(
        ([type, data]) => ({
          type,
          count: data.count,
          total_amount_wei: data.totalAmountWei.toString(),
          total_platform_fee_wei: data.totalPlatformFeeWei.toString(),
          total_organizer_amount_wei: data.totalOrganizerAmountWei.toString()
        })
      ),
      daily_trends: Object.values(dailyTrends).map(trend => ({
        date: trend.date,
        type: trend.type,
        count: trend.count,
        total_amount_wei: trend.totalAmountWei.toString()
      })),
      top_events_by_revenue: Object.values(eventRevenue)
        .sort((a, b) => Number(b.totalRevenue - a.totalRevenue))
        .slice(0, 10)
        .map(event => ({
          event_id: event.eventId,
          tickets_sold: event.ticketsSold,
          total_revenue_wei: event.totalRevenue.toString(),
          organizer_revenue_wei: event.organizerRevenue.toString(),
          platform_fees_wei: event.platformFees.toString()
        }))
    }

    callback(null, response)
  } catch (error) {
    console.error('❌ GetAdminAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get admin analytics'
    })
  }
}

// ✅ NEW: Organizer analytics function
async function GetOrganizerAnalytics (call, callback) {
  const { organizer_id, date_range } = call.request

  try {
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : new Date()

    // Get organizer's transaction logs
    const { logs } = await TransactionLogger.getTransactionLogs({
      organizerId: organizer_id,
      fromDate: startDate,
      toDate: endDate,
      status: 'CONFIRMED'
    })

    // Process for organizer analytics
    const transactionSummary = {}
    const eventBreakdown = {}

    logs.forEach(log => {
      // Transaction summary by type
      if (!transactionSummary[log.type]) {
        transactionSummary[log.type] = {
          count: 0,
          totalRevenue: BigInt(0),
          ticketsSold: 0
        }
      }

      transactionSummary[log.type].count++
      if (log.type === 'TICKET_PURCHASE') {
        transactionSummary[log.type].totalRevenue += BigInt(
          log.organizerAmountWei || '0'
        )
        transactionSummary[log.type].ticketsSold += log.metadata?.quantity || 1
      }

      // Event breakdown (only for ticket purchases)
      if (log.type === 'TICKET_PURCHASE' && log.eventId) {
        if (!eventBreakdown[log.eventId]) {
          eventBreakdown[log.eventId] = {
            eventId: log.eventId,
            ticketsSold: 0,
            totalRevenue: BigInt(0),
            platformFeesPaid: BigInt(0)
          }
        }

        eventBreakdown[log.eventId].ticketsSold += log.metadata?.quantity || 1
        eventBreakdown[log.eventId].totalRevenue += BigInt(
          log.organizerAmountWei || '0'
        )
        eventBreakdown[log.eventId].platformFeesPaid += BigInt(
          log.platformFeeWei || '0'
        )
      }
    })

    const response = {
      organizer_id,
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      transaction_summary: Object.entries(transactionSummary).map(
        ([type, data]) => ({
          type,
          count: data.count,
          total_revenue_wei: data.totalRevenue.toString(),
          tickets_sold: data.ticketsSold
        })
      ),
      event_breakdown: Object.values(eventBreakdown).map(event => ({
        event_id: event.eventId,
        tickets_sold: event.ticketsSold,
        total_revenue_wei: event.totalRevenue.toString(),
        platform_fees_paid_wei: event.platformFeesPaid.toString()
      }))
    }

    callback(null, response)
  } catch (error) {
    console.error('❌ GetOrganizerAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get organizer analytics'
    })
  }
}

module.exports = {
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics,
  GetAdminAnalytics, // ✅ NEW
  GetOrganizerAnalytics // ✅ NEW
}
