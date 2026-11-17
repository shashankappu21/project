/** NSE equity session: 09:15–15:30 IST, Monday to Friday. Exchange holidays are not modelled. */
const OPEN_MINUTE = 9 * 60 + 15;
const CLOSE_MINUTE = 15 * 60 + 30;
const IST_OFFSET_MS = 5.5 * 3600_000;

export function isNseOpen(at: Date): boolean {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minute >= OPEN_MINUTE && minute < CLOSE_MINUTE;
}
