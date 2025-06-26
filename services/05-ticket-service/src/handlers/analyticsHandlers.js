// services/05-ticket-service/src/handlers/analyticsHandlers.js

const { Ticket, TICKET_STATUS_ENUM } = require('../models/Ticket')
const PlatformTransaction = require('../models/PlatformTransaction')
const mongoose = require('mongoose')

// Dashboard tổng quan cho 1 event
async function GetEventDashboard (call, callback) {
  const { event_id, date_range } = call.request

  try {
    const now = new Date()
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : now

    // 1. Ticket Sales Summary
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
          // Group by status: PENDING_PAYMENT, PAID, MINTED, etc.
        }
      }
    ])

    // 2. Revenue Summary từ PlatformTransaction
    const revenueStats = await PlatformTransaction.aggregate([
      {
        $match: {
          eventId: event_id,
          createdAt: { $gte: startDate, $lte: endDate },
          status: 'RECEIVED'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: { $toDouble: '$amountWei' } },
          platformFees: { $sum: { $toDouble: '$platformFeeWei' } },
          organizerRevenue: { $sum: { $toDouble: '$organizerAmountWei' } },
          transactionCount: { $sum: 1 }
        }
      }
    ])

    // 3. Check-in Statistics
    const checkinStats = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          status: TICKET_STATUS_ENUM[4] // MINTED
        }
      },
      {
        $group: {
          _id: '$checkInStatus',
          count: { $sum: 1 }
        }
      }
    ])

    // 4. Daily Sales Trend (last 30 days)
    const dailySales = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $in: [TICKET_STATUS_ENUM[1], TICKET_STATUS_ENUM[4]] } // PAID or MINTED
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          ticketsSold: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ])

    // Format response
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
      revenue_summary: revenueStats[0]
        ? {
            total_revenue_wei: revenueStats[0].totalRevenue.toString(),
            platform_fees_wei: revenueStats[0].platformFees.toString(),
            organizer_revenue_wei: revenueStats[0].organizerRevenue.toString(),
            transaction_count: revenueStats[0].transactionCount
          }
        : {
            total_revenue_wei: '0',
            platform_fees_wei: '0',
            organizer_revenue_wei: '0',
            transaction_count: 0
          },
      checkin_summary: {
        total_minted: checkinStats.reduce((sum, stat) => sum + stat.count, 0),
        by_status: checkinStats.map(stat => ({
          status: stat._id || 'NOT_CHECKED_IN',
          count: stat.count
        }))
      },
      daily_trends: dailySales.map(day => ({
        date: `${day._id.year}-${day._id.month
          .toString()
          .padStart(2, '0')}-${day._id.day.toString().padStart(2, '0')}`,
        tickets_sold: day.ticketsSold
      }))
    }

    callback(null, dashboard)
  } catch (error) {
    console.error('Analytics: GetEventDashboard error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event dashboard'
    })
  }
}

// Real-time stats cho organizer dashboard
async function GetOrganizerStats (call, callback) {
  const { organizer_id } = call.request

  try {
    // Get all events của organizer (cần call event-service)
    const eventServiceClient = require('../clients/eventServiceClient')
    const eventsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.ListEvents({ organizer_id }, (err, response) => {
        if (err) return reject(err)
        resolve(response)
      })
    })

    const eventIds = eventsResponse.events?.map(e => e.id) || []

    if (eventIds.length === 0) {
      return callback(null, {
        organizer_id,
        total_events: 0,
        total_tickets_sold: 0,
        total_revenue_wei: '0',
        active_events: 0
      })
    }

    // Aggregate stats across all events
    const organizerStats = await Ticket.aggregate([
      {
        $match: {
          eventId: { $in: eventIds },
          status: { $in: [TICKET_STATUS_ENUM[1], TICKET_STATUS_ENUM[4]] } // PAID or MINTED
        }
      },
      {
        $group: {
          _id: null,
          totalTicketsSold: { $sum: 1 },
          uniqueEvents: { $addToSet: '$eventId' }
        }
      }
    ])

    // Revenue stats
    const revenueStats = await PlatformTransaction.aggregate([
      {
        $match: {
          eventId: { $in: eventIds },
          status: 'RECEIVED'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: { $toDouble: '$organizerAmountWei' } }
        }
      }
    ])

    callback(null, {
      organizer_id,
      total_events: eventIds.length,
      total_tickets_sold: organizerStats[0]?.totalTicketsSold || 0,
      total_revenue_wei: revenueStats[0]?.totalRevenue?.toString() || '0',
      active_events: organizerStats[0]?.uniqueEvents?.length || 0
    })
  } catch (error) {
    console.error('Analytics: GetOrganizerStats error:', error)
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
  GetCheckinAnalytics
}
