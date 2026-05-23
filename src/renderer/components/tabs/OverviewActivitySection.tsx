import { useEffect, useMemo, useState } from 'react'
import type { ConversationSummary } from '../../../preload/api'

/**
 * Detailed activity section appended to Overview. Ported from Unleashed's
 * HomeScreen DetailedStats panel — but with the "10-min default" omitted in
 * favor of an honest sessionsMissingDuration footer.
 *
 * Pulls per-conversation meta from `history:list-conversations` and computes
 * derived stats in one pass O(N).
 */

interface DetailedStats {
  totalSessions: number
  totalTokens: number
  totalTimeMinutes: number
  avgSessionLength: number
  sessions7Days: number
  sessions30Days: number
  time7Days: number
  time30Days: number
  recentActivity: { date: string; sessions: number; minutes: number }[]
  topProjects: { name: string; folder: string; sessions: number; timeMinutes: number }[]
  totalProjects: number
  peakHour: number
  peakDay: string
  hourlyDistribution: number[]
  dailyDistribution: number[]
  productivityScore: number
  sessionsMissingDuration: number
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function computeDetailedStats(conversations: ConversationSummary[]): DetailedStats {
  const empty: DetailedStats = {
    totalSessions: 0, totalTokens: 0, totalTimeMinutes: 0, avgSessionLength: 0,
    sessions7Days: 0, sessions30Days: 0, time7Days: 0, time30Days: 0,
    recentActivity: [], topProjects: [], totalProjects: 0,
    peakHour: 0, peakDay: 'N/A',
    hourlyDistribution: Array(24).fill(0), dailyDistribution: Array(7).fill(0),
    productivityScore: 0, sessionsMissingDuration: 0,
  }
  if (conversations.length === 0) return empty

  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000)

  let sessions7Days = 0, sessions30Days = 0, time7Days = 0, time30Days = 0
  let totalTokens = 0, totalMinutes = 0
  let countedDurationSessions = 0, sessionsMissingDuration = 0

  const activityMap = new Map<string, { sessions: number; minutes: number }>()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    activityMap.set(localDateStr(d), { sessions: 0, minutes: 0 })
  }

  const projectCounts = new Map<string, { name: string; folder: string; count: number; timeMinutes: number }>()
  const hourlyDistribution = Array(24).fill(0) as number[]
  const dailyDistribution = Array(7).fill(0) as number[]

  for (const conv of conversations) {
    const convDate = new Date(conv.timestamp)
    if (Number.isNaN(convDate.getTime())) continue
    const convDateStr = localDateStr(convDate)

    const hasDuration = typeof conv.stats?.duration === 'number' && Number.isFinite(conv.stats.duration)
    const durationMinutes = hasDuration ? Math.round((conv.stats!.duration as number) / 60_000) : 0
    if (!hasDuration) sessionsMissingDuration++

    const tokens = conv.stats?.estimatedTokens ?? 0

    hourlyDistribution[convDate.getHours()]++
    dailyDistribution[convDate.getDay()]++

    if (convDate >= sevenDaysAgo) {
      sessions7Days++
      if (hasDuration) time7Days += durationMinutes
    }
    if (convDate >= thirtyDaysAgo) {
      sessions30Days++
      if (hasDuration) time30Days += durationMinutes
    }

    const dayData = activityMap.get(convDateStr)
    if (dayData) {
      dayData.sessions++
      if (hasDuration) dayData.minutes += durationMinutes
    }

    if (conv.projectFolder) {
      const existing = projectCounts.get(conv.projectFolder)
      if (existing) {
        existing.count++
        if (hasDuration) existing.timeMinutes += durationMinutes
      } else {
        projectCounts.set(conv.projectFolder, {
          name: conv.projectFolder.split('/').pop() || 'Unknown',
          folder: conv.projectFolder,
          count: 1,
          timeMinutes: hasDuration ? durationMinutes : 0,
        })
      }
    }

    totalTokens += tokens
    if (hasDuration) { totalMinutes += durationMinutes; countedDurationSessions++ }
  }

  const topProjects = Array.from(projectCounts.values())
    .sort((a, b) => b.timeMinutes - a.timeMinutes || b.count - a.count)
    .slice(0, 5)
    .map((p) => ({ name: p.name, folder: p.folder, sessions: p.count, timeMinutes: p.timeMinutes }))

  const recentActivity = Array.from(activityMap.entries()).map(([date, data]) => ({
    date, sessions: data.sessions, minutes: data.minutes,
  }))

  const peakHour = hourlyDistribution.indexOf(Math.max(...hourlyDistribution))
  const peakDayIndex = dailyDistribution.indexOf(Math.max(...dailyDistribution))
  const peakDay = DAY_NAMES[peakDayIndex] || 'N/A'

  const avgSessionsPerDay = conversations.length / 7
  const variance = dailyDistribution.reduce((s, c) => s + Math.pow(c - avgSessionsPerDay, 2), 0) / 7
  const consistency = Math.max(0, 100 - Math.sqrt(variance) * 10)
  const productivityScore = Math.round(Math.min(100, consistency + (sessions7Days > 0 ? 20 : 0)))

  return {
    totalSessions: conversations.length, totalTokens, totalTimeMinutes: totalMinutes,
    avgSessionLength: countedDurationSessions > 0 ? Math.round(totalMinutes / countedDurationSessions) : 0,
    sessions7Days, sessions30Days, time7Days, time30Days,
    recentActivity, topProjects, totalProjects: projectCounts.size,
    peakHour, peakDay, hourlyDistribution, dailyDistribution,
    productivityScore, sessionsMissingDuration,
  }
}

export function OverviewActivitySection() {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.history
      .listConversations()
      .then((r) => { if (!cancelled) setConversations(r.conversations) })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [])

  const stats = useMemo<DetailedStats | null>(
    () => (conversations ? computeDetailedStats(conversations) : null),
    [conversations],
  )

  if (error) {
    return (
      <section className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Activity</h3>
        <div className="text-xs text-fg-faint">activity scan failed: {error}</div>
      </section>
    )
  }
  if (!stats) {
    return (
      <section className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Activity</h3>
        <div className="text-xs text-fg-faint">scanning transcripts…</div>
      </section>
    )
  }
  if (stats.totalSessions === 0) {
    return (
      <section className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Activity</h3>
        <div className="text-xs text-fg-faint">no conversations yet</div>
      </section>
    )
  }

  return (
    <section className="mt-6 space-y-4">
      <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Activity</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="sessions 7d" value={stats.sessions7Days.toString()} />
        <Card label="time 7d" value={formatMinutes(stats.time7Days)} />
        <Card label="sessions 30d" value={stats.sessions30Days.toString()} />
        <Card label="time 30d" value={formatMinutes(stats.time30Days)} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="total sessions" value={stats.totalSessions.toString()} />
        <Card label="total time" value={formatMinutes(stats.totalTimeMinutes)} />
        <Card label="avg session" value={`${stats.avgSessionLength}m`} />
        <Card label="total tokens" value={formatNumber(stats.totalTokens)} />
      </div>

      <div className="border border-line rounded p-3 bg-bg-elev">
        <div className="text-xs text-fg-faint uppercase tracking-wider mb-2">7-day activity</div>
        <div className="flex items-end gap-1 h-20">
          {stats.recentActivity.map((day, i, arr) => {
            const maxSessions = Math.max(...arr.map((d) => d.sessions), 1)
            const height = day.sessions > 0 ? Math.max((day.sessions / maxSessions) * 100, 15) : 6
            const isToday = i === arr.length - 1
            const cls = isToday ? 'bg-accent' : day.sessions > 0 ? 'bg-accent/40' : 'bg-line'
            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col items-center gap-1"
                title={`${day.date}: ${day.sessions} sessions, ${day.minutes}m`}
              >
                <div className={`w-full rounded-sm transition-all ${cls}`} style={{ height: `${height}%` }} />
                <span className="text-[10px] text-fg-faint">
                  {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' }).charAt(0)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-line rounded p-3 bg-bg-elev">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-2">24h activity</div>
          <div className="flex items-end gap-0.5 h-12">
            {stats.hourlyDistribution.map((count, hour) => {
              const max = Math.max(...stats.hourlyDistribution, 1)
              const height = count > 0 ? Math.max((count / max) * 100, 8) : 3
              const isWorkHour = hour >= 9 && hour <= 18
              const cls = count === 0 ? 'bg-line' : isWorkHour ? 'bg-accent/70' : 'bg-accent/30'
              return (
                <div
                  key={hour}
                  className={`flex-1 rounded-t-sm ${cls}`}
                  style={{ height: `${height}%` }}
                  title={`${hour}:00 — ${count} sessions`}
                />
              )
            })}
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-fg-faint">
            <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span>
          </div>
        </div>

        <div className="border border-line rounded p-3 bg-bg-elev">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-2">by day of week</div>
          <div className="flex items-end gap-1 h-12">
            {stats.dailyDistribution.map((count, dow) => {
              const max = Math.max(...stats.dailyDistribution, 1)
              const height = count > 0 ? Math.max((count / max) * 100, 8) : 3
              return (
                <div key={dow} className="flex-1 flex flex-col items-center gap-1" title={`${DAY_NAMES[dow]}: ${count} sessions`}>
                  <div className={`w-full rounded-t-sm ${count > 0 ? 'bg-accent/60' : 'bg-line'}`} style={{ height: `${height}%` }} />
                </div>
              )
            })}
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-fg-faint">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((c, i) => (
              <span key={i} className="flex-1 text-center">{c}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="border border-line rounded p-3 bg-bg-elev">
        <div className="text-xs text-fg-faint uppercase tracking-wider mb-3">work patterns</div>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center">
            <div className="text-2xl font-mono text-accent">
              {stats.peakHour % 12 === 0 ? 12 : stats.peakHour % 12}
              <span className="text-sm ml-1">{stats.peakHour >= 12 ? 'PM' : 'AM'}</span>
            </div>
            <div className="text-[10px] text-fg-faint mt-1 uppercase tracking-wider">peak hour</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-mono text-accent pt-1">{stats.peakDay.slice(0, 3)}</div>
            <div className="text-[10px] text-fg-faint mt-1 uppercase tracking-wider">most active day</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-mono text-accent">{stats.productivityScore}</div>
            <div className="text-[10px] text-fg-faint mt-1 uppercase tracking-wider">consistency</div>
          </div>
        </div>
        <div className="h-2 w-full rounded-full bg-line overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${stats.productivityScore}%` }} />
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-fg-faint">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </div>

      <div className="border border-line rounded p-3 bg-bg-elev">
        <div className="text-xs text-fg-faint uppercase tracking-wider mb-3">top projects by time</div>
        {stats.topProjects.length === 0 ? (
          <div className="text-xs text-fg-faint">no project data yet</div>
        ) : (
          <div className="space-y-2">
            {stats.topProjects.map((p) => {
              const maxTime = stats.topProjects[0]?.timeMinutes || 1
              const percent = maxTime > 0 ? (p.timeMinutes / maxTime) * 100 : 0
              return (
                <div key={p.folder} className="flex items-center gap-2 text-xs" title={p.folder}>
                  <span className="text-fg-dim truncate flex-1 font-mono">{p.name}</span>
                  <div className="w-24 h-1.5 rounded-full bg-line overflow-hidden flex-shrink-0">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <span className="text-fg-faint w-16 text-right flex-shrink-0">{formatMinutes(p.timeMinutes)}</span>
                  <span className="text-fg-faint w-12 text-right flex-shrink-0 font-mono">{p.sessions}×</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="text-[10px] text-fg-faint">
        time totals include only sessions with measured first→last timestamps.
        {stats.sessionsMissingDuration > 0 && (
          <> {stats.sessionsMissingDuration} session{stats.sessionsMissingDuration === 1 ? '' : 's'} excluded for missing duration.</>
        )}
      </div>
    </section>
  )
}

function Card({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs text-fg-faint uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-mono ${dim ? 'text-fg-faint' : 'text-fg'}`}>{value}</div>
    </div>
  )
}
