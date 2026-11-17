// "Why does this scenario exist?" links: shows `project #number` for the usual trackers, whatever the URL looks like.
export function parseIssueUrl(text) {
  let u
  try { u = new URL(String(text ?? '').trim()) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const seg = u.pathname.split('/').filter(Boolean)
  let m
  // GitHub: /org/repo/issues/12, /org/repo/pull/12
  if (u.hostname.endsWith('github.com') && seg.length >= 4 && ['issues', 'pull'].includes(seg[2]) && /^\d+$/.test(seg[3])) {
    return { url: u.href, project: seg[1], number: seg[3], kind: seg[2] === 'pull' ? 'PR' : 'issue', label: `${seg[1]} #${seg[3]}` }
  }
  // GitLab: /group/project/-/issues/12, /-/merge_requests/12
  const dash = seg.indexOf('-')
  if (dash >= 2 && ['issues', 'merge_requests'].includes(seg[dash + 1]) && /^\d+$/.test(seg[dash + 2] ?? '')) {
    return { url: u.href, project: seg[dash - 1], number: seg[dash + 2], kind: seg[dash + 1] === 'issues' ? 'issue' : 'PR', label: `${seg[dash - 1]} #${seg[dash + 2]}` }
  }
  // Jira / Linear style keys: /browse/ABC-123, /team/issue/ABC-123/title
  if ((m = u.pathname.match(/\/([A-Z][A-Z0-9]+)-(\d+)(?:\/|$)/))) return { url: u.href, project: m[1], number: m[2], kind: 'issue', label: `${m[1]}-${m[2]}` }
  // anything else: host and the last path segment
  const last = seg.at(-1)
  return { url: u.href, project: u.hostname.replace(/^www\./, ''), number: last ?? '', kind: 'link', label: last ? `${u.hostname.replace(/^www\./, '')} · ${decodeURIComponent(last)}` : u.hostname }
}
