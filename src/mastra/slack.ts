// Optional Slack delivery for the finished triage card. No token/channel configured => a
// no-op 'skipped', so the demo runs without Slack. Fire-and-forget; a Slack outage never
// fails the (read-only) triage.
export async function maybePostSlack(card: string): Promise<'posted' | 'skipped'> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL
  if (!token || !channel) return 'skipped'
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text: card, mrkdwn: true }),
  }).catch(() => null)
  return res && res.ok ? 'posted' : 'skipped'
}
