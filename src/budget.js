/**
 * A hard request budget for a page's calls to a shared service (the rides Worker shares the
 * Cloudflare account's free 100,000 requests a day with the games' leaderboards). Every call asks
 * first; the answer is '' to go ahead or the reason to skip. Reads must be `readGapMs` apart and the
 * page may send at most `perHour` requests in any hour, whatever the code around it does.
 */
export function createBudget({ readGapMs = 30_000, perHour = 40 } = {}) {
  const sent = [];
  let lastRead = -Infinity;
  return function check(isRead, now = Date.now()) {
    while (sent.length && now - sent[0] >= 3600_000) sent.shift();
    if (sent.length >= perHour) return 'hourly budget used';
    if (isRead && now - lastRead < readGapMs) return 'read too soon';
    sent.push(now);
    if (isRead) lastRead = now;
    return '';
  };
}
